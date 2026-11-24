import { isIP } from "node:net";

/**
 * Per-client-IP rate limiting of the HTTP API. TESTNET ONLY. In memory: the service
 * is a single instance (advisory lock), so one process sees every request.
 *
 * Sliding window: at most `perMinute` requests in any 60 seconds (1-second resolution),
 * per client. Every admitted request counts, whatever its route or its answer (4xx and
 * 404 included); a refused one (429) does no work and is not counted, so Retry-After is
 * exact. Reads (GET, OPTIONS, HEAD) and writes (POST) have separate windows; writes are
 * stricter (each one verifies a signature, may read the chain and writes to the
 * database).
 *
 * (A token bucket used to be here. With a burst of N and a refill of N/60 per second,
 * a client sending at internet round-trip pace earned new tokens while it sent, so N+1
 * requests in a minute never got 429.)
 *
 * The client IP: see `clientKey`. `X-Forwarded-For` is never read: a client can put
 * anything in it. IPv6 clients are limited per /64, the block one subscriber usually
 * gets, so rotating addresses inside it does not multiply the allowance.
 */

export type ProxyTrust = "railway" | "none";

/** The one bucket shared by every request whose client address is unknown. */
export const NO_CLIENT_IP = "shared:no-client-ip";

export interface RateLimiterOptions {
  perMinute: number;
  /** Milliseconds (injected for tests). */
  now: () => number;
  /** Clients kept at most; the least recently seen ones are dropped beyond it. */
  maxClients?: number;
}

export type Admission = { ok: true } | { ok: false; retryAfterSecs: number };

const WINDOW_SECS = 60;

interface Window {
  /** Requests admitted in each of the last 60 seconds, indexed by second % 60. */
  slots: Uint32Array;
  /** The second the slots were last advanced to. */
  sec: number;
  /** The sum of the slots. */
  total: number;
}

export class RateLimiter {
  private readonly clients = new Map<string, Window>();
  private readonly limit: number;
  private readonly now: () => number;
  private readonly maxClients: number;

  constructor(o: RateLimiterOptions) {
    if (!Number.isInteger(o.perMinute) || o.perMinute < 1) throw new RangeError("perMinute must be a positive integer");
    this.limit = o.perMinute;
    this.now = o.now;
    this.maxClients = o.maxClients ?? 50_000;
  }

  /** Counts one request for `client`, or refuses it if the last 60 s already hold `perMinute`. */
  take(client: string): Admission {
    const nowMs = this.now();
    const sec = Math.floor(nowMs / 1000);
    let w = this.clients.get(client);
    if (w) {
      this.clients.delete(client); // re-inserted below: Map order = least recently seen first
      advance(w, sec);
    } else {
      w = { slots: new Uint32Array(WINDOW_SECS), sec, total: 0 };
    }
    this.clients.set(client, w);
    if (w.total >= this.limit) {
      // The earliest second whose expiry brings the count below the limit.
      let freed = 0;
      for (let s = sec - WINDOW_SECS + 1; s <= sec; s++) {
        freed += w.slots[mod(s)]!;
        if (w.total - freed < this.limit) {
          return { ok: false, retryAfterSecs: Math.max(1, Math.ceil(((s + WINDOW_SECS) * 1000 - nowMs) / 1000)) };
        }
      }
      return { ok: false, retryAfterSecs: WINDOW_SECS }; // unreachable: the window holds `total`
    }
    w.slots[mod(sec)]! += 1;
    w.total += 1;
    while (this.clients.size > this.maxClients) {
      // Dropping a window only refills that client's allowance; it never blocks anyone.
      this.clients.delete(this.clients.keys().next().value!);
    }
    return { ok: true };
  }

  /** Clients currently tracked (diagnostics, tests). */
  size(): number {
    return this.clients.size;
  }
}

const mod = (sec: number) => ((sec % WINDOW_SECS) + WINDOW_SECS) % WINDOW_SECS;

/** Moves the window to `sec`, emptying the seconds that fell out of it. */
function advance(w: Window, sec: number): void {
  if (sec <= w.sec) return; // a clock step back keeps the counts (never in the client's favour)
  if (sec - w.sec >= WINDOW_SECS) {
    w.slots.fill(0);
    w.total = 0;
  } else {
    for (let s = w.sec + 1; s <= sec; s++) {
      w.total -= w.slots[mod(s)]!;
      w.slots[mod(s)] = 0;
    }
  }
  w.sec = sec;
}

/**
 * The rate-limit key of a request: the client's IP (IPv4, or the /64 of an IPv6
 * address).
 *
 * - `trust: "railway"`: ONLY the `X-Real-IP` header Railway's edge sets. The TCP peer
 *   is never used there (it is Railway's proxy, and may differ from one request to the
 *   next). If the header holds several addresses (a client-sent copy the edge appended
 *   to, or repeated header lines, which Node joins with ", "), the LAST one is taken:
 *   the one added by the hop nearest to the service, i.e. the edge.
 * - `trust: "none"` (local): the TCP peer address.
 *
 * No usable address: the one shared bucket `NO_CLIENT_IP`, never a fresh or unlimited one.
 */
export function clientKey(trust: ProxyTrust, realIp: string | undefined, peer: string | undefined): string {
  if (trust === "railway") {
    const last = realIp?.split(",").at(-1);
    return normalizeIp(last) ?? NO_CLIENT_IP;
  }
  return normalizeIp(peer) ?? NO_CLIENT_IP;
}

function normalizeIp(raw: string | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  const v = isIP(ip);
  if (v === 4) return ip;
  if (v === 6) return `${expandIpv6(ip).slice(0, 4).join(":")}::/64`;
  return null;
}

/** The eight hextets of an IPv6 address (lowercase, no leading zeros). */
function expandIpv6(ip: string): string[] {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  // An embedded IPv4 tail becomes two hextets.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    s = s.slice(0, v4.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.includes("::") ? (s.split("::") as [string, string]) : [s, null];
  const h = head === "" ? [] : head.split(":");
  const t = tail === null || tail === "" ? [] : tail.split(":");
  const middle = tail === null ? [] : Array(8 - h.length - t.length).fill("0");
  return [...h, ...middle, ...t].map((x) => parseInt(x, 16).toString(16));
}
