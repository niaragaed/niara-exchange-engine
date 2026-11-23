import { isIP } from "node:net";

/**
 * Per-client-IP rate limiting of the HTTP API. TESTNET ONLY. In memory: the service
 * is a single instance (advisory lock), so one process sees every request.
 *
 * Token buckets: a client may burst up to `perMinute` requests, then gets
 * `perMinute / 60` per second. Reads (GET, OPTIONS, HEAD) and writes (POST) have
 * separate buckets; writes are stricter (each one verifies a signature, may read the
 * chain and writes to the database).
 *
 * The client IP: with `trust: "railway"` it is Railway's `X-Real-IP` header, which
 * Railway's edge proxy sets on every request; otherwise the TCP peer address.
 * `X-Forwarded-For` is never read: a client can put anything in it. IPv6 clients are
 * limited per /64, the block one subscriber usually gets, so rotating addresses inside
 * it does not multiply the allowance.
 */

export type ProxyTrust = "railway" | "none";

export interface RateLimiterOptions {
  perMinute: number;
  /** Milliseconds (injected for tests). */
  now: () => number;
  /** Buckets kept at most; the least recently used ones are dropped beyond it. */
  maxClients?: number;
}

export type Admission = { ok: true } | { ok: false; retryAfterSecs: number };

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly capacity: number;
  private readonly perMs: number;
  private readonly now: () => number;
  private readonly maxClients: number;

  constructor(o: RateLimiterOptions) {
    if (!Number.isInteger(o.perMinute) || o.perMinute < 1) throw new RangeError("perMinute must be a positive integer");
    this.capacity = o.perMinute;
    this.perMs = o.perMinute / 60_000;
    this.now = o.now;
    this.maxClients = o.maxClients ?? 50_000;
  }

  /** Takes one token for `client`. */
  take(client: string): Admission {
    const now = this.now();
    const b = this.buckets.get(client);
    let tokens = this.capacity;
    if (b) {
      tokens = Math.min(this.capacity, b.tokens + Math.max(0, now - b.at) * this.perMs);
      this.buckets.delete(client); // re-inserted below: Map order = least recently used first
    }
    if (tokens < 1) {
      this.buckets.set(client, { tokens, at: now });
      return { ok: false, retryAfterSecs: Math.max(1, Math.ceil((1 - tokens) / this.perMs / 1000)) };
    }
    this.buckets.set(client, { tokens: tokens - 1, at: now });
    while (this.buckets.size > this.maxClients) {
      // Dropping a bucket only refills that client's allowance; it never blocks anyone.
      this.buckets.delete(this.buckets.keys().next().value!);
    }
    return { ok: true };
  }

  /** Clients currently tracked (diagnostics, tests). */
  size(): number {
    return this.buckets.size;
  }
}

/**
 * The rate-limit key of a request: the client's IP (IPv4, or the /64 of an IPv6
 * address). `realIp` is the X-Real-IP header, used only when `trust` is "railway"
 * and it holds a valid IP; otherwise the peer address.
 */
export function clientKey(trust: ProxyTrust, realIp: string | undefined, peer: string | undefined): string {
  const fromProxy = trust === "railway" ? normalizeIp(realIp) : null;
  return fromProxy ?? normalizeIp(peer) ?? "unknown";
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
