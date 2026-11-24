# Deploying the order service on Railway (api.niaraglobal.com)

**TESTNET ONLY.** The service matches signed order intents and settles them on Solana
devnet and EVM testnets (Base Sepolia). There are no real assets and no real money. It
holds no regulatory authorization. Nothing here applies to a mainnet deployment.

What runs: one Railway service built from this repository's `Dockerfile`:

- Node 22.23.4.
- Started with `node src/service/main.ts`.
- One process holding three things:
  - the HTTP API;
  - the matching engine (in memory, rebuilt from the database on start);
  - the settlement worker, which signs with the operator keys.

The database is the Supabase project `niara-exchange-dev`. Schema changes stay
migrations applied by hand; a deploy never applies one.

## 1. Create the service

1. **Make the code reachable.** In Railway: New project, then Deploy from GitHub repo.
   Pick `niara-exchange-engine` and the branch to deploy. Railway builds from GitHub,
   so the commits must be pushed first. The alternative is `railway up` from a local
   checkout with the Railway CLI.
2. **Builder.** Railway finds the `Dockerfile` at the root and builds it. There is
   nothing to choose.

   This repository has no `railway.json`. Railway no longer lets new services use
   config-as-code (`railway.json` / `railway.toml`), and it stops reading those files
   on 2026-12-01. The settings below are therefore service settings in the dashboard.
3. **Service settings** (the service's Settings tab):

   | Setting | Value | Why |
   |---|---|---|
   | Healthcheck path | `/health` | A deployment goes live only once this returns 2xx |
   | Healthcheck timeout | `300` s (default) | The first start rebuilds the books and connects to the RPCs |
   | Replicas | **1**, one region | See "Why exactly one replica" |
   | Restart policy | On failure, max 10 retries | The service exits on purpose when it loses the database (it then restarts and rebuilds) |
   | Serverless / app sleeping | **Off** | A sleeping service runs no settlement worker and no expiry sweep |
   | Public networking | HTTP domain only. **No TCP proxy** | A TCP proxy bypasses Railway's edge, and with it the `X-Real-IP` header the rate limit trusts |
   | Volumes | None | The service keeps no local state. A volume also forces downtime on every redeploy |
   | Region | Close to the Supabase project | Every request makes database round trips |

4. **Variables.** Set them as in section 3 before the first deploy. Mark every secret
   as **sealed**: Railway then hides the value in the dashboard and never shows it again.

## 2. Why exactly one replica

The service must run as exactly one instance:

- **The books.** The order books live in memory, and each match is decided in one
  process under one mutex. Two instances would build two diverging books from the same
  orders.
- **The worker.** The settlement worker sends on-chain transactions with the operator
  keys. Two workers could both try to settle the same match. The on-chain program and
  contracts refuse a second settlement, but the second attempt still costs gas, and its
  failure path would mark a settled match failed.
- **The rate limit** is kept in memory, per instance.

**How it's enforced.** On start the service takes a Postgres advisory lock
(`pg_try_advisory_lock`) on its single database connection. Only the holder serves and
settles. The lock lives as long as that connection does. If the connection drops, the
process exits, Railway restarts it, and it rebuilds from the database. This is also why
`DATABASE_URL` must be a direct or session-mode connection: the transaction pooler (port
6543) cannot hold a session lock, and the service refuses it.

**During a redeploy:**

1. Railway starts the new deployment while the previous one still runs, and stops the
   previous one only once the new one passes `/health`.
2. The previous deployment still holds the lock, so the new instance does not exit. It
   waits in **standby** for up to `INSTANCE_LOCK_WAIT_SECS` (600 s on Railway). In
   standby:
   - it listens on `PORT`;
   - `/health` answers 200 `{"status":"standby"}`, so Railway can switch traffic and stop
     the previous deployment;
   - every API path answers `503 {"error":"starting"}` with `Retry-After: 5`.
3. When the previous deployment stops, its connection closes and the lock is released.
4. The new instance takes the lock, rebuilds its books, logs `serving`, and starts the
   worker.

Expect a few seconds of 503s on each redeploy. Set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`
(section 3) so that the previous deployment shuts down cleanly rather than being killed.

**If a second replica were configured,** it would stay in standby while still receiving
its share of traffic, so those requests would get 503s. After 600 s it would exit and be
restarted, over and over. It would never serve or settle, because the lock still refuses
it, but the API would degrade. Keep replicas at 1.

The same applies to a local `npm start` against the same database while Railway runs.
Locally the wait is 0, so it exits at once with `refused_to_start`. Stop any local
instance before the first Railway deploy, or the Railway instance stays in standby until
the local one stops.

Before the operator keys are loaded, the service fails the deployment rather than going
live if any of these is wrong:

- the configuration;
- the database connection, including TLS;
- the RPC chain checks (genesis hash, chain id);
- the operator keys.

## 3. Environment variables

**Secret** values go only into Railway variables, sealed. Never put one in a file in the
repository or in a `NEXT_PUBLIC_*` variable. The service refuses to start if a
`NEXT_PUBLIC_*` variable names or contains a server secret. No secret is ever logged:
- The startup line shows each variable's presence or name, never a secret value.
- Every log line goes through redaction.

### Set by Railway (do not set)

| Variable | Notes |
|---|---|
| `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_PROJECT_ID`, `RAILWAY_SERVICE_ID` | Injected. Their presence means "on Railway", which sets the defaults for `HOST`, `TRUST_PROXY` and `INSTANCE_LOCK_WAIT_SECS` |
| `PORT` | Railway injects one. Setting `PORT=8787` explicitly is also fine: Railway then routes the domain to 8787. Range 1–65535 |

### Required

| Variable | Secret | Railway value | Notes |
|---|---|---|---|
| `DATABASE_URL` | **yes** | `postgresql://LOGIN_ROLE:PASSWORD@<pooler host>:5432/postgres?sslmode=verify-full` | Use Supabase's **session-mode pooler** (port 5432, host `*.pooler.supabase.com`), as in the local `.env`. The direct host `db.<ref>.supabase.co` is IPv6-only, and Railway's outbound traffic may not reach it. Never port 6543 (refused). The login role must be a member of `service_role`. TLS: `sslmode` must be `verify-full` (added if absent; weaker modes refused). Without `sslrootcert`, the server is verified against the committed `config/supabase-ca.crt`, so no file has to be uploaded. Do not copy the local `sslrootcert=/home/...` path: that file does not exist on Railway, and the service would refuse to start |
| `CORS_ORIGINS` | no | `https://niaraglobal.com,https://www.niaraglobal.com` | Exact origins, comma-separated. `*` and any wildcard are refused. `http://` is refused except for localhost. Add `http://localhost:3000` only to test a local site against the deployed API |
| `SOLANA_OPERATOR_KEYPAIR_JSON` | **yes** | The content of `~/.config/niara-exchange/devnet/settlement-operator.json` (a JSON array of 64 numbers) | Required while the worker is on. Paste it without displaying it (section 4) |
| `EVM_SETTLEMENT_CHAINS` | no | `base-sepolia` | EVM testnets the worker settles on. Empty means none. Each must be marked reviewed in `config/evm-testnets.json` |
| `EVM_OPERATOR_KEYSTORE_JSON` | **yes** | The content of the Foundry keystore `niara-evm-operator` (one line of JSON) | Required while `EVM_SETTLEMENT_CHAINS` is set. It is encrypted, but treat it as secret anyway |
| `EVM_OPERATOR_KEYSTORE_PASSWORD` | **yes** | The keystore's password | Required with the keystore |

### Hosting and abuse limits (defaults are right for Railway)

| Variable | Secret | Railway value | Notes |
|---|---|---|---|
| `HOST` | no | *unset* | Default 0.0.0.0 on Railway, 127.0.0.1 locally. `::` also works. A loopback value is refused on Railway |
| `TRUST_PROXY` | no | *unset* | Default `railway` on Railway: the client IP for rate limiting is only the `X-Real-IP` header that Railway's edge sets (several values: the last); requests without a usable one share one bucket. `none` (the TCP peer) is the local default and is refused on Railway. `X-Forwarded-For` is never read |
| `RATE_LIMIT_READS_PER_MIN` | no | `300` (default) | Per client IP (IPv6: per /64). GET, preflights and unknown paths. At most that many in any 60 s (sliding window) |
| `RATE_LIMIT_WRITES_PER_MIN` | no | `30` (default) | Per client IP. Every POST, whatever its answer (4xx included), in a window of its own: the 31st in any 60 s is refused. Over the limit: 429 `rate_limited` with `Retry-After` |
| `MAX_BODY_BYTES` | no | `16384` (default) | Larger bodies get 413 |
| `MAX_OPEN_ORDERS_PER_WALLET` | no | `50` (default) | Per wallet, per chain |
| `INSTANCE_LOCK_WAIT_SECS` | no | *unset* (600) | How long a new deployment waits in standby for the previous one to release the lock (section 2). 0–3600 |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | no | `30` | Railway's own: the time between SIGTERM and SIGKILL for the previous deployment. Railway's default is 0, an immediate kill. 30 s lets it stop the worker and close the database connection cleanly |
| `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS` | no | `0` | Railway's own: how long the previous deployment stays up after the new one is live. The new one cannot serve before the previous one stops, so any overlap only lengthens the 503 window |

### Matching, settlement and chains (defaults are fine)

| Variable | Secret | Default | Notes |
|---|---|---|---|
| `SETTLEMENT_MARGIN_SECS` | no | `60` | An order matches only while it has more than this left before expiry |
| `EXPIRY_SWEEP_SECS` | no | `30` | How often expired orders are swept |
| `MARKET_REFRESH_SECS` | no | `60` | How often chains and listings are re-read |
| `DELEGATE_CHECK` | no | `on` | On-chain delegate and allowance checks before matching and settling (spec §3.5) |
| `WORKER_ENABLED` | no | `on` | `off` = matches stay pending (no keys needed) |
| `WORKER_POLL_SECS` | no | `5` | |
| `WORKER_MAX_ATTEMPTS` | no | `6` | |
| `SETTLE_DEADLINE_MARGIN_SECS` | no | `90` | A settlement is sent only if it can land this long before expiry |
| `SOLANA_RPC_URL` | **yes if private** | *unset* (the public devnet RPC) | A provider URL with an API key is a secret. Devnet is enforced by genesis hash |
| `BASE_SEPOLIA_RPC_URL` | **yes if private** | *unset* (`https://sepolia.base.org`) | Chain id checked on start |
| `ROBINHOOD_TESTNET_RPC_URL`, `TEMPO_TESTNET_RPC_URL`, `HYPEREVM_TESTNET_RPC_URL` | **yes if private** | *unset* | Only read for chains listed in `EVM_SETTLEMENT_CHAINS` |

### Do not set on Railway

| Variable | Why |
|---|---|
| `SOLANA_OPERATOR_KEYPAIR`, `EVM_OPERATOR_KEYSTORE` | File paths, for local use. They point at files that don't exist on Railway. Setting a path together with its `_JSON` variable is refused |
| `SUPABASE_SERVICE_ROLE_KEY` | Not used: the service talks to Postgres directly |
| `EVM_INVESTOR_A_KEYSTORE_PASSWORD`, `EVM_INVESTOR_B_KEYSTORE_PASSWORD` | Used only by `scripts/e2e-evm.ts`, never by the service |
| Any `NEXT_PUBLIC_*` | Frontend-only (the site's Vercel project). The service refuses one that carries a secret |
| `NODE_ENV` | Set to `production` in the image |

## 4. Putting the keys into Railway without displaying them

Copy each file to the Windows clipboard from WSL, then paste it into a new **sealed**
variable in the dashboard (Variables, New variable). The value never shows in the
terminal or in the shell history.

```bash
clip.exe < ~/.config/niara-exchange/devnet/settlement-operator.json   # SOLANA_OPERATOR_KEYPAIR_JSON
clip.exe < /mnt/c/Users/<you>/.foundry/keystores/niara-evm-operator     # EVM_OPERATOR_KEYSTORE_JSON
```

Clear the clipboard afterwards (copy anything else). Type the keystore password into its
own sealed variable. Never paste a key into a chat, an issue or a commit.

**On Railway the keys are only as safe as the Railway account and project.** Anyone with
access to the project's variables can read the unsealed ones, and every deployment sees
all of them. These are devnet and testnet keys with no real value. A mainnet operator key
would need a KMS or HSM, not an environment variable.

## 5. Custom domain: api.niaraglobal.com

1. **Add the domain in Railway.** Go to the service's Settings, Networking, Public
   Networking, then **+ Custom Domain**. Enter `api.niaraglobal.com`. If Railway asks for
   a target port, use the service's `PORT` (8787 if you set it).
2. **Copy the two records Railway shows:**
   - a **CNAME**: `api` → `<something>.up.railway.app`;
   - a **TXT** record for ownership verification.

   The exact values differ per domain and appear only in the dashboard.
3. **Create both records** at the DNS provider of `niaraglobal.com`:
   - Type `CNAME`, name `api`, target the Railway value.
   - Type `TXT`, with the name and value Railway shows.

   Both are required. The domain does not verify with the CNAME alone, and until it
   verifies, requests to it return 404.
4. **If the DNS is on Cloudflare, set the `api` record to DNS only** (grey cloud), not
   proxied. Behind Cloudflare's proxy, Railway's `X-Real-IP` would be a Cloudflare
   address, and the per-IP rate limit would put all clients sharing a Cloudflare edge into
   one bucket. Railway also documents that a proxied setup needs SSL mode Full; Full
   (Strict) does not work.
5. **Wait for the dashboard to show the domain verified** and the certificate issued.
   Railway issues it, usually within an hour of DNS resolving; DNS itself can take longer.
   Check DNS from outside:

   ```bash
   dig +short CNAME api.niaraglobal.com     # the *.up.railway.app target
   dig +short TXT <the TXT name Railway shows>
   ```

The site (Vercel, `https://niaraglobal.com` and `https://www.niaraglobal.com`) then sets
`NEXT_PUBLIC_ENGINE_URL=https://api.niaraglobal.com` in its own Vercel project, not here.

## 6. Verifying from outside

Run these from any machine; they use only public endpoints.

**Health.** Expect `{"status":"ok","testnet":true,...}`. `"standby"` appears only for
the few seconds of a redeploy switch-over (section 2).

```bash
curl -sS https://api.niaraglobal.com/health
```

**Markets.**

```bash
curl -sS https://api.niaraglobal.com/v1/markets | jq '.chains[] | {id, ordersAccepted, settlementEnabled, markets: [.markets[] | .symbol]}'
```

Expect `solana-devnet` and `base-sepolia` with `ordersAccepted: true` and
`settlementEnabled: true`. `settlementEnabled: false` means the worker has no adapter for
that chain: check `WORKER_ENABLED`, `EVM_SETTLEMENT_CHAINS` and the keys. The markets
list each approved equity listing with its symbol and name.

**CORS.**

1. A preflight from the site must be allowed. Expect `204` with
   `access-control-allow-origin: https://niaraglobal.com`,
   `access-control-allow-methods: GET,POST,OPTIONS` and
   `access-control-allow-headers: content-type`, and no
   `access-control-allow-credentials`.

   ```bash
   curl -sS -i -X OPTIONS https://api.niaraglobal.com/v1/orders \
     -H "Origin: https://niaraglobal.com" \
     -H "Access-Control-Request-Method: POST" \
     -H "Access-Control-Request-Headers: content-type"
   ```

2. Repeat with `-H "Origin: https://www.niaraglobal.com"`. Expect that origin echoed.
3. Another origin must not be allowed. Expect no `access-control-allow-origin` header at
   all, never `*`.

   ```bash
   curl -sS -i https://api.niaraglobal.com/health -H "Origin: https://evil.example" | grep -i access-control || echo "no CORS header: refused"
   ```

4. In a browser at `https://niaraglobal.com`, open the devtools console and run the
   following. It should print the markets with no CORS error.

   ```js
   fetch("https://api.niaraglobal.com/v1/markets").then(r => r.json()).then(console.log)
   ```

**Rate limit, and that `X-Real-IP` cannot be spoofed.** Railway documents that its edge
sets `X-Real-IP`. Whether it also *replaces* a copy sent by the client is not
documented, so test it once after the first deploy.

Two runs of 31 POSTs with the body `{}`: the service answers 400 to it, and nothing
is parsed into an order or written. Wait a minute between the two runs, so the first
does not fill the window of the second.

```bash
# 1. Plain: the 31st POST in a minute is refused.
for i in $(seq 1 31); do
  curl -sS -o /dev/null -w "%{http_code} " -X POST https://api.niaraglobal.com/v1/orders \
    -H "content-type: application/json" --data '{}'
done; echo
sleep 61
# 2. Each request claims a different X-Real-IP: it must not buy a fresh allowance.
for i in $(seq 1 31); do
  curl -sS -o /dev/null -w "%{http_code} " -X POST https://api.niaraglobal.com/v1/orders \
    -H "content-type: application/json" -H "X-Real-IP: 198.51.100.$i" --data '{}'
done; echo
```

- **Expected, both runs:** thirty `400` and then a `429`.
- **If run 1 ends in `400`,** the limit is not enforced. Stop and report it.
- **If only run 2 ends in `400`,** the edge passed the forged header through in place
  of its own: anyone could dodge the limit. Stop and report it. Do not run this check
  behind Cloudflare's proxy (section 5).

Your address then waits up to a minute before it can POST again; reads are unaffected.

**Logs** (Railway, the service's Deployments tab, View logs). These lines should appear:

- `starting`: the configuration. Its `platform` is `railway`, `host` is `0.0.0.0`,
  `trustProxy` is `railway`, `databaseTls` is "server verified against the committed
  Supabase CA", and the operator keys appear as "env ... (set, not shown)".
- `listening`, then `service_started` and `serving`.
- `worker_starting`, once per chain, with the operator's public address.

There must be no `solana_program_mismatch` and no `config_error`. A `refused_to_start`
after `waiting_for_instance_lock` means another instance held the lock for the whole
wait, for example a local `npm start` against the same database.

## 7. Checklist of manual steps

1. **Prepare the code and the database.**
   - Push the branch Railway deploys. Nothing has been pushed from here.
   - Stop any local instance that uses the same database.
   - Confirm every migration in the README table is applied. The service refuses to
     start with `SchemaNotReadyError` otherwise.
2. **Create the Railway service** with the settings of section 1.
3. **Set the variables** of section 3:
   - Secrets sealed, keys pasted as in section 4.
   - `DATABASE_URL` without the local `sslrootcert` path.
   - The two Railway deployment variables.
4. **Deploy.** Watch the logs for `serving` and `worker_starting`.
5. **Set up the custom domain** with its CNAME and TXT records (section 5), DNS only if on
   Cloudflare.
6. **Run the checks of section 6,** including the `X-Real-IP` spoofing check.
7. **Point the site at the API:** set `NEXT_PUBLIC_ENGINE_URL=https://api.niaraglobal.com`
   in the Vercel project.
8. **Fund the settlement operators.** Each settlement costs the operator gas. Top up the
   Solana operator with devnet SOL and the EVM operator with Base Sepolia ETH, from
   faucets.
