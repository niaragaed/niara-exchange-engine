# Design decisions

Decisions this repo makes on top of the spec
(`niara-exchange-solana/EXCHANGE-MULTICHAIN-DESIGN.md`). The spec is the
source of truth; where a decision here needs the spec to change, it is
listed under "Spec edits needed" at the end. The first two rounds of proposals are
now in the spec (see "Spec edits applied").

> Testnet only: no real assets, no real money, no regulatory authorization.

## Units

- **Quantity**: asset base units (the mint's or token's smallest unit), always
  a whole number of **lots**. `lot_size` is an off-chain market parameter on
  the listing.
- **Price**: USDT base units **per lot**. The payment of a fill is
  `quantity / lot_size * price`, an exact integer, so a fill never needs
  rounding and is exactly within both limit prices. A per-whole-token price
  would need rounding on fractional fills, and rounding breaks one of the two
  limits at the boundary.
- `lot_size` is part of the signed intent: changing it would change what a
  signed price means, so the engine refuses an order whose lot size is not the
  market's, and refuses a lot change while orders rest.
- TypeScript uses `bigint`; Postgres uses `public.base_units`, an integer
  `numeric` capped at uint256 that rejects fractions instead of rounding them
  (`numeric(78,0)` would round 1.5 to 2).

## Chains

The five v1 chains (`solana-devnet`, `base-sepolia`, `robinhood-testnet`,
`hyperevm-testnet`, `tempo-testnet`) are identified by CAIP-2 ids:
`eip155:<chainId>` and `solana:<first 32 chars of the genesis hash>`. The
`chains` table holds per-chain configuration: settlement program/contract
and USDT (null until deployed), minimum order notional, and maximum intent
validity.

## Order intents (`src/intents`)

Signed fields: version, chain (CAIP-2), settlement program/contract, wallet,
side, asset, quantity, lot size, limit price, payment asset (USDT), nonce
(16 random bytes), **expiry** (unix seconds, required) and, from v2, the
**time in force** (`GTC` or `IOC`, below).

- **Versions.** Plain orders sign v2. v1 is still accepted and means `GTC`; a
  v1 intent that carries `timeInForce` is refused (v1 never signed it, so an
  unsigned field may not change what the wallet agreed to). v2 requires it.
  Icebergs sign **v3** (v2 plus `displayQuantity`, "Iceberg orders" below); a
  v1 or v2 intent that carries `displayQuantity` is refused, and is shown
  whole.

- **Solana**: a fixed, labeled UTF-8 text with the testnet notice, signed with
  `signMessage` (552 bytes for a typical intent). The verifier rebuilds the
  text from the structured intent and never parses signed text. Strict
  ed25519 (`zip215: false`), like the Ed25519 program's `verify_strict`. v2
  changes the first line to `Niara Exchange order intent v2` and adds one line
  after the limit price: `Time in force: GTC (rests in the book until filled,
  cancelled or expired)` or `Time in force: IOC (fills now up to the limit
  price; the rest is cancelled)`. A v1 text is unchanged.
- **EVM**: EIP-712. Domain `{ name: "Niara Exchange", version: "1", chainId,
  verifyingContract: NiaraSettlement }`; type
  `OrderIntent(address wallet,uint8 side,address asset,uint256 quantity,uint256 lotSize,uint256 limitPrice,address paymentAsset,bytes16 nonce,uint64 expiresAt)`
  with `side` 0 = buy, 1 = sell (v1). v2 appends `uint8 timeInForce`
  (0 = GTC, 1 = IOC):
  `OrderIntent(address wallet,uint8 side,address asset,uint256 quantity,uint256 lotSize,uint256 limitPrice,address paymentAsset,bytes16 nonce,uint64 expiresAt,uint8 timeInForce)`.
  Same primary type name and domain (domain `version` stays `"1"`: the
  contract did not change); the type hash differs, so a v1 and a v2 digest
  never coincide. Only 65-byte, `v` 27/28, low-s signatures, as OpenZeppelin
  `ECDSA`.
- **No contract change.** Neither `niara_exchange::settle` nor
  `NiaraSettlement.settle` verifies intents today (the operator is the
  documented trust assumption of spec §3.6), so a new signed field changes no
  program or contract. The on-chain signed-intents milestone must rebuild both
  versions (v1 and v2 texts, both type hashes).
- **Amounts** must fit the on-chain width: u64 on Solana (including the
  notional, which becomes `payment_amount`), uint256 on EVM. In JSON they are
  decimal strings only.
- **Expiry window**: the server refuses `expiresAt <= now` and
  `expiresAt > now + chains.max_intent_validity_secs` (default 30 days, the
  same as the P2P deal limit `MAX_DEAL_DURATION_SECS`).
- **Nonce**: unique per (chain, wallet) (`orders` unique constraint), so a
  signed intent can enter the book only once.
- `admitOrderIntent` is the order service's gate (below). Market checks
  (approved equity, lot size, minimum notional) stay in the engine.

## Cancellation (`src/intents/cancel.ts`)

A wallet cancels one of its orders by signing the order's chain, settlement
program/contract, wallet and **nonce**. The nonce is unique per
(chain, wallet), so it names exactly one order, ever: the cancellation needs
no nonce or expiry of its own, and replaying it only re-cancels a cancelled
order.

Its version is its own (`CANCEL_VERSION = 1`), not the order intent's: a
cancellation names the order by nonce, which is the same in every intent
version, so the v1 cancellation cancels v1 and v2 orders alike and did not
change with v2.

- **Solana**: `signMessage` text, verified like the order intent (rebuilt from
  the structured cancellation, strict ed25519). Its first line differs from
  the order intent's, so neither text can be taken for the other:

  ```
  Niara Exchange cancel order v1
  TESTNET ONLY: no real assets, no real money.

  Chain: solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1
  Program: <program id>
  Wallet: <wallet>
  Order nonce: <32 lowercase hex chars>
  ```
- **EVM**: EIP-712 with the order intent's domain and
  `CancelOrder(address wallet,bytes16 nonce)`; same signature rules (65 bytes,
  `v` 27/28, low `s`). The digest never equals an order intent's.
- `admitCancelIntent` checks the chain configuration (program) and the
  signature; the service then looks the order up by (chain, wallet, nonce).
- **Off-chain only.** The service takes the order out of the book. Until
  `settle` verifies intents on-chain (spec §3.6), the on-chain guarantee that
  a cancelled order never settles is the wallet revoking its delegate or
  allowance. An on-chain `cancel_intent` belongs to the on-chain
  signed-intents milestone, not to this one.
- **Recorded** (migration `20261120130000_cancel_reasons`): every path that
  takes an order out of the book writes `orders.cancel_reason`, in the same
  transaction as the new status:

  | Reason | Status | Written by |
  |---|---|---|
  | `by_wallet` | cancelled | `POST /v1/orders/cancel`; `cancel_signature` holds the wallet's signature exactly as sent |
  | `self_trade_prevention` | cancelled | the engine, newest order of a wallet that would trade with itself |
  | `below_min_notional` | cancelled | the engine, remainder or next match below the minimum |
  | `ioc_unfilled` | cancelled | the engine, the unmatched remainder of an IOC order (migration `20261124120000`) |
  | `expired` | expired | the expiry sweep, matching, or a failed match |
  | `stale` | stale | the delegate check, or a failed match (`match_reversals`) |

  The reason follows the status (table check); the signature is present
  exactly for `by_wallet`. The signed message is not stored: it is rebuilt
  from the order (chain, wallet, nonce), the chain's settlement
  program/contract and the cancellation version (1), as for the order intent. Once
  written, the signature never changes and the reason changes only from
  `stale` (a stale order can still be cancelled by its wallet, and becomes
  `by_wallet`). The service derives the reason from the engine's events
  (`closingOf` in `src/service/persist.ts`); the engine is unchanged. Neither
  column is readable by `anon`/`authenticated`.

## Matching engine (`src/engine`)

- Deterministic: no clock, no randomness, no I/O. The caller passes `now` and
  the match id generator (`randomMatchId`, a CSPRNG UUID v4, in production).
  The engine checks that each id is a fresh UUID v4, which also rules out the
  all-zero id (`ZeroMatchId` on-chain).
- Price-time priority, where time is arrival order in the engine (`seq`), not
  wall-clock time. A fill trades at the **maker's** limit price.
- **Self-trade prevention: cancel newest.** When an incoming order would cross
  a resting order of the same wallet, the incoming order's remainder is
  cancelled (after filling better-priced orders of other wallets) and the
  resting order stays. The book therefore never crosses.
- **Settlement margin** (60 s by default): an order is accepted and matched
  only while `expiresAt - now > margin`, so a match leaves time to settle. A
  match's `expiresAt` is the earlier of its two orders' expiries.
- Only `approved` `equity` markets take orders. `fixed_income`, `credit` and
  `currency` (P2P escrow) are refused with `not_order_book_asset`. A
  suspended market keeps its resting orders, which match again after
  reinstatement.
- `markStale` takes an order out of the book when the on-chain delegate or
  allowance no longer covers it (spec §3.5). The on-chain check runs outside
  the engine.
- **Minimum order notional** (spec §9.12 item 1), per chain: an order below
  it is refused at entry; a match below it is never made; a remainder below
  it, valued at its own limit price, is cancelled (`below_min_notional`)
  instead of resting. When the next match would fall below the minimum, the
  order whose remainder limits that match is cancelled: the resting order
  (matching then continues with the next one; this happens to an order left
  below a raised minimum) or the incoming order (matching stops; a buyer whose
  remainder is worth less than the minimum at the best ask). The engine never
  skips the best price to reach a larger match. **Final** (confirmed by the
  founder on 2026-11-20).
- **Time in force**: a `GTC` order's remainder rests; an `IOC` order matches
  at once up to its limit and its remainder is cancelled (`ioc_unfilled`).
  Details in "Time in force and market orders" below.
- **Iceberg** (`displayQuantity`, GTC only): only a visible slice rests; a
  used-up slice is refreshed at the same price with a new time priority.
  Price-time priority uses each order's priority (its `seq`, or the sequence
  of its latest slice). Details in "Iceberg orders" below.
- **Restart**: `restore` rebuilds the books from the non-terminal orders in
  their original `seq`, with their fills, on a fresh engine; `exportState`
  returns everything that decides future behavior (markets, each book's
  priority order, live orders, next sequences).

## Schema (`supabase/migrations`)

- Tables `chains`, `listings`, `orders`, `matches`, `settlements`; enums for
  asset class, listing, order, match and settlement status;
  `settlements.match_id` unique; composite foreign keys keep orders, matches
  and settlements on one market and chain.
- Triggers keep signed order fields immutable, keep fills monotonic and
  terminal statuses terminal, and re-check every match (sides, market, no
  self-trade, price within both limits, `payment_amount * lot_size =
  quantity * price`, UUID v4 id).
- RLS on every table. `anon`/`authenticated` read `chains`, approved
  equity/currency listings, and the price-level columns of live orders
  (`order_book` view, `security_invoker`), never wallets, ids, nonces or
  signatures. They write nothing. The service role (the order service, which
  verifies the signatures, and later the worker) inserts and updates; nobody
  deletes.
- Tested against PGlite 0.4.6 (Postgres 17.5 in WASM, in process).
- `20261116120000_exchange_schema` is applied to the remote
  `niara-exchange-dev` (by the founder, through the Supabase dashboard
  tooling, not from this repo). `20261116130000_fk_indexes` (indexes covering
  the composite foreign keys `matches (chain_id, asset)` and
  `settlements (match_id, chain_id)`) is applied too (by the founder; seen
  on the remote on 2026-11-16). This repo never applies migrations to the
  remote.

- **`20261122120000_listing_metadata`** (site item 6): `listings.symbol`
  and `listings.name`, nullable text, filled by both listing syncs from the
  token's own on-chain metadata (the Token-2022 `TokenMetadata` extension of
  a Solana mint, `symbol()` and `name()` of an EVM token). Never guessed and
  never taken from the config files (whose `symbol` stays a review label,
  printed next to the on-chain one when they differ). Checks: trimmed, no
  control characters, 1–32 characters for the symbol and 1–128 for the
  name; a published value outside them is stored as null and reported by
  the sync. Display only: a symbol is not unique, the address is the
  identity. Anon reads them through the existing table-level grant and row
  policy. The order service requires it (it refuses to start, naming it,
  until it is applied). **Ready for the founder to apply; not applied by
  this repo.** After applying it, re-run both syncs with `--apply` to fill
  the columns.
- Solana metadata kept outside the mint (a `MetadataPointer` to another
  account, or Metaplex) is not read, the same as the site's reader; such a
  listing gets null symbol and name. Which devnet mints carry the extension
  is not checked here (no chain access); the sync's dry run shows it.

## Order service (`src/service`)

- **One Node process, one instance.** Hono HTTP API: `POST /v1/orders`
  (`{ intent, signature }`), `POST /v1/orders/cancel`
  (`{ cancel, signature }`), `GET /v1/orders?chain=&wallet=`,
  `GET /v1/orders/:id`, `GET /v1/matches?chain=&wallet=`,
  `GET /v1/matches/:id`, `GET /v1/trades/:chain/:asset`, `GET /v1/markets`,
  `GET /v1/books/:chain/:asset`, `GET /health`. Amounts are decimal strings
  in JSON.
- **Single instance, enforced.** On start the service takes a session-level
  Postgres advisory lock (`pg_try_advisory_lock(hashtextextended(
  'niara-exchange-engine/order-service', 0))`) on its only database
  connection; a second instance finds it taken and refuses to start. The lock
  lives as long as the connection: if the connection drops, the process exits
  (another instance may already hold the lock) and its supervisor restarts
  it. The transaction pooler (Supabase port 6543) cannot hold a session lock
  and is refused by the configuration.
- **One transaction per state change.** Each change runs under one
  in-process mutex and in one transaction as `service_role`: the database
  checks (nonce, open orders), the engine call, then the order, its matches
  and every order it changed are written together. The engine is in memory,
  so a failed write leaves it ahead of the database: the service then answers
  503 to everything and the process exits; the restart rebuilds from the
  database, and the same signed intent can be submitted again (its nonce was
  not consumed).
- **Server role.** The service connects to Postgres directly and runs every
  transaction after `set local role service_role`, so the migration's grants
  apply to it (insert and update, never delete). The login role must be a
  member of `service_role` (checked on start). The Supabase service role key
  (a REST credential) is not used.
- **Sequences.** `orders.seq` and `matches.seq` store the engine's arrival
  and match sequences (`overriding system value`), so the database and the
  engine share one time priority and the next sequences continue from the
  stored maxima after a restart.
- **Addresses.** The engine works with checksummed EVM addresses (as
  admission returns them). `orders.asset` and `matches.asset` reuse the
  listing's stored spelling, because they reference `listings` by foreign key.
- **Abuse limits.** Nonce unique per (chain, wallet), checked before the
  engine and by the unique constraint (409); at most
  `MAX_OPEN_ORDERS_PER_WALLET` non-terminal, unexpired orders per wallet and
  chain (429); request bodies above `MAX_BODY_BYTES` refused before parsing
  (413). Bad signatures get 401, other admission refusals 422.
- **Public book**: price levels of matchable orders only (an order within the
  settlement margin of its expiry is hidden before the sweep), never wallets,
  order ids or nonces.
- **Housekeeping.** Timers sweep expired orders (`EXPIRY_SWEEP_SECS`) and
  re-read chains and listings (`MARKET_REFRESH_SECS`); a lot size change while
  orders rest is refused and logged.
- **Settlement** is the worker's (below), in the same process; with
  `WORKER_ENABLED=off`, matches stay `pending`.
- **A wallet's orders** (`GET /v1/orders?chain=&wallet=&limit=&before=`,
  site item 2): every status, newest first by `seq`, pages of 50 (at most
  100; `before` is the previous page's last `seq`, `next` is null on the last
  page). Each order carries its nonce (what a signed cancellation names),
  `cancelReason`, the failed-match counters and `createdAt`; never the intent
  or cancellation signature. The wallet is matched in its canonical spelling
  (checksummed on EVM).
  **Unsigned, testnet only.** Anyone can list any wallet's orders by
  address. On testnet that is accepted: nothing of value is at stake, and a
  settled trade's wallets and amounts are public on-chain anyway. **A mainnet deployment must require the
  wallet's sign-in** (a short-lived, wallet-signed read token) for this
  endpoint and for `GET /v1/matches?chain=&wallet=`: a wallet's resting
  orders, limit prices, expiries and nonces, tied to its address, show what
  it is about to trade and help front-run it, which the public book (price
  levels only, no wallets) does not.
- **One order** (`GET /v1/orders/:id`, site item 3): read from the
  database, so it answers any status and orders the engine no longer holds
  after a restart; the order (as in the wallet list), its `matchIds`, and its
  matches oldest first with their settlement (status, attempts, tx hash,
  error, `settledAt` once confirmed). Matches carry order ids, never wallets.
  Public by id: order ids are random UUID v4s handed to the wallet at
  placement.
- **A wallet's matches** (`GET /v1/matches?chain=&wallet=&limit=&before=`,
  site item 4): the matches where the wallet bought or sold, newest first,
  paged like the orders; each with the wallet's `side`, `role` (maker or
  taker) and `orderId`, the match terms, and the settlement with the same
  fields as `GET /v1/matches/:id` (status, attempts, tx hash, error), so a
  fill that happened after the site's tab closed still shows its explorer
  link. No counterparty wallet. Unsigned on testnet, sign-in on mainnet (as
  the orders above).
- **Trades of a market** (`GET /v1/trades/:chain/:asset?limit=&before=&since=`,
  site item 5): matches confirmed on-chain only (match `settled`, settlement
  `confirmed`), newest first, pages of 100 (at most 500); each with
  `matchedAt` (the trade time, for candles), `settledAt`, price, quantity,
  payment amount, taker side and tx hash. No wallets and no order ids: the
  same public data a block explorer shows. `since` (unix seconds) keeps
  trades matched at or after it. A matched but unsettled match is not a
  trade: it may still fail and be reversed.
- **Markets** (`GET /v1/markets`, site items 7 and 8): every v1 chain, from
  the service's catalog (as last read from `chains` and `listings`, re-read
  every `MARKET_REFRESH_SECS`; no database read per request): its CAIP-2
  id, settlement program, quote asset (with decimals, symbol and name when
  it is listed), minimum notional, intent validity, `ordersAccepted`
  (program and quote asset configured) and `settlementEnabled`, and its
  markets (approved equity listings: asset, on-chain symbol and name,
  decimals, lot size). `settlementEnabled` is derived from the worker: true
  exactly for the chains the running worker holds an adapter for, i.e.
  Solana devnet plus `EVM_SETTLEMENT_CHAINS` (each marked reviewed in
  `config/evm-testnets.json`, which the service checks on start), and false
  everywhere with `WORKER_ENABLED=off`. A chain with `ordersAccepted` but
  not `settlementEnabled` matches orders whose matches stay `pending`.
- **CORS** (for the Niara site, `niara-site/docs/engine-changes-needed.md`
  item 1). Only the exact origins in `CORS_ORIGINS` (comma-separated
  `scheme://host[:port]`; `http://localhost:3000` for now, the Vercel domain
  once deployed) get `Access-Control-Allow-Origin`, echoed back with
  `Vary: Origin`; `*`, wildcards and anything with a path are refused by the
  configuration. Methods `GET, POST, OPTIONS`, request header `content-type`,
  no credentials (the API has no cookies or sessions), preflights cached
  600 s. The headers are set on every response, errors included, so the
  browser can read a 4xx body. CORS only limits browsers: it is not access
  control, and every endpoint stays safe to call from anywhere.

## Configuration (`src/config.ts`, `.env.example`)

Environment variables only (`npm start` runs `node --env-file=.env`):
`DATABASE_URL` (required, secret), `HOST`, `PORT`, `MAX_BODY_BYTES`,
`MAX_OPEN_ORDERS_PER_WALLET`, `SETTLEMENT_MARGIN_SECS`, `EXPIRY_SWEEP_SECS`,
`MARKET_REFRESH_SECS`, `SOLANA_RPC_URL` (optional, devnet only),
`DELEGATE_CHECK`, `WORKER_ENABLED`, `SOLANA_OPERATOR_KEYPAIR` (a path),
`WORKER_POLL_SECS`, `WORKER_MAX_ATTEMPTS`, `SETTLE_DEADLINE_MARGIN_SECS`,
`CORS_ORIGINS`. The service refuses to start when a `NEXT_PUBLIC_*` variable names a server
secret (service role, password, database URL, private or operator key,
keypair, JWT secret) or contains the database URL, its password,
`SUPABASE_SERVICE_ROLE_KEY` or a private RPC URL. Logs never show any part of
the database URL.

## Tooling

TypeScript 7.0.2 (strict), vitest 5.0.5 with one worker, fast-check 4.10.2,
@noble/ed25519 3.2.0, @scure/base 2.4.0, viem 2.57.14, pg 8.23.1,
hono 4.13.16, @hono/node-server 2.1.6 (the first release with the fixes for
GHSA-qv5m-9pm6-hqp3 and GHSA-jpvv-r467-5p4w), all pinned exactly; new
packages are at least two weeks old when added. vitest's hook timeout is
240 s: PGlite takes up to a minute to start in a worker on the dev machine.
`.npmrc` sets `legacy-peer-deps` because npm 10 crashes resolving vitest 5's
optional peer chain; `vite` and `@types/node` are pinned directly instead.

## Solana devnet settlement (`src/solana`, `src/adapters`, `src/worker`)

- **IDL, not hand-written layouts.** The `niara_exchange` IDL is vendored in
  `src/solana/idl` (a test checks it equals the Solana repo's build, whose
  bytes match the program deployed on devnet). A small Borsh codec driven by
  the IDL encodes `settle` and decodes `Config`, `Listing` and the `Settled`
  event; it throws on any IDL type it does not know. `@anchor-lang/core` and
  `@solana/spl-token` are not used: spl-token pulls `bigint-buffer`
  (GHSA-3gc7-fjrx-p6mg, no fix). Only `@solana/web3.js` 1.98.4, whose
  remaining advisories are moderate and transitive (`jayson` →
  `stream-json`, `uuid`).
- **Devnet only.** Every Solana entry point (adapter, sync, e2e, service)
  checks the RPC's genesis hash and refuses anything but devnet.
- **Adapter.** `settle(match_id = the 16 bytes of the match UUID,
  asset_amount = quantity, payment_amount)`, between the parties'
  associated token accounts (the intent names wallets, not token accounts).
  Order per match: if `["settled", match_id]` exists, nothing is sent and the
  transaction that created it is returned (`alreadySettled`; the oldest
  successful signature of the record); else build, sign (operator only),
  **simulate** (a failed simulation is never sent), send once, confirm. A
  retry after an ambiguous confirmation starts again from the record check.
  Program errors map to the IDL's name and message (`DelegateNotSet (6025):
  Token account has not delegated to the vault authority`); Anchor
  constraint errors are read from the logs; an "already in use" record means
  settled; RPC trouble (and unknown RPC errors) and `Config.paused` are
  transient. The adapter refuses an operator key that is not
  `Config.settlement_operator`.
- **Operator key.** A path in `SOLANA_OPERATOR_KEYPAIR`; the file must be
  outside the repository and mode 600; errors never quote it; it is never
  logged.
- **Delegate check (spec §3.5), both legs.** `settle` moves both legs
  through the vault PDA, so a sell order is covered by its asset account
  (delegate = vault, delegated and balance ≥ remaining) and a buy order by
  its USDT account (≥ remaining / lot × limit price). Before matching: the
  new order is refused if uncovered (422 `delegate_not_covered`); the resting
  orders it would cross are checked best first until enough covered quantity
  is found, and uncovered ones are marked `stale` in the same transaction as
  the placement. If the chain cannot be read the order is refused (503), not
  matched unchecked. Before settling: the worker checks the match's two
  needs; an uncovered order is marked stale and the match fails. The check is
  per order: aggregate approvals across several orders of one wallet are not
  summed.
- **Worker.** In the order service process (the advisory lock makes it the
  only one). Oldest match first (`pending`, or `settling` after a crash). Per
  match: (1) already settled on-chain? confirm, send nothing (this comes
  first: after a crash mid-send the delegation is already consumed, and a
  coverage check would fail a settled match); (2) fail if `expires_at` has
  passed, or is less than `SETTLE_DEADLINE_MARGIN_SECS` (90 s) away: a sent
  transaction can land up to a blockhash lifetime later, and spec §2 says a
  match never settles after `expiresAt`, which the chain does not check yet;
  (3) delegate check; (4) `settling` + attempt recorded, adapter call;
  (5) `settled` + `confirmed` (tx hash), or `failed` + readable error.
  Transient errors: exponential backoff 2 s doubling, capped at 60 s, at
  most `WORKER_MAX_ATTEMPTS` (6) rounds, each restarting at (1); after the
  last, one final on-chain check before failing. One match at a time, in
  order (a retrying match holds the ones behind it).
- **Never twice:** one worker; the record check before every send; the
  adapter's own check; the program's `init` of the record; the unique
  `settlements.match_id`.
- **Listing sync.** Reads the program's `Listing` accounts (read-only),
  upserts the Approved ones with a lot size from the reviewed
  `config/solana-devnet.json` (none is guessed: a listing without one is
  skipped), updates the status of mirrored ones that are no longer
  Approved, and sets `chains.settlement_program` and `chains.quote_asset`
  (checked against `Config.fee_mint`). Dry run by default; `--apply` writes
  only when the config is marked reviewed; a lot size never changes while
  the market has live orders. `listings.tx_hash` is left null: reading
  accounts does not say which transaction changed them.
- **Secrets in logs.** No part of `DATABASE_URL` is logged (the startup log
  says "set, not shown"), and every logged error goes through
  `redactSecrets` (URL, user, host, password, a private RPC URL and its
  query values, the service key): driver errors can quote them.

## EVM testnet settlement (`src/evm`, `src/adapters/evm-adapter.ts`)

Base Sepolia, Robinhood Chain testnet and Tempo testnet; HyperEVM once
deployed. Same shape as Solana: one adapter per chain behind
`SettlementAdapter`, the same worker, the same fault rules.

- **ABIs vendored, not hand-written.** `src/evm/abi/` holds the ABIs of
  NiaraSettlement, ListingRegistry, CashbackDistributor and NativeAssetToken,
  generated from `niara-contracts/out` (forge build of 2026-11-15, source
  unchanged since, commit `ffbfa68`; that repo's working tree differs from it
  only in line endings). viem 2.57.14 encodes, decodes and signs; no other
  EVM package.
- **Per-chain settings in `config/evm-testnets.json`** (public values only,
  each with its source): contract addresses and the operator from the
  niara-contracts README ("v1 deployments"; the three chains share
  addresses because the deployer used nonces 0 to 10 on each), the first
  block of each deployment (event scans start there), gas rules and the
  reviewed lot sizes. A chain settles, and the sync writes, only when the
  file marks it `"reviewed": true`; every address is checked on-chain before
  use (NiaraSettlement's `feeToken`, `listingRegistry` and
  `cashbackDistributor`, and the operator's `SETTLEMENT_OPERATOR_ROLE`).

  | Chain | Pricing | Gas limit | Cap | Source |
  |---|---|---|---|---|
  | Base Sepolia | EIP-1559 | estimate × 1.30 | none | README "Network quirks": forge's default 130 |
  | Robinhood testnet | EIP-1559 | estimate × 2.00 | none | README: 200 (L1 data component follows the L1 price) |
  | Tempo testnet | Tempo `0x76`, fee in pathUSD `0x20c0…0000` | estimate × 2.00 | 30,000,000 | README "Tempo fees": the node's own estimate is already Tempo-priced for calls against current state (phase 2 needed 1.0×, ran at 200); 30M is the block's general gas limit |
  | HyperEVM testnet | legacy (`gasPrice`) | estimate × 1.30 | 3,000,000 | not deployed; legacy per the founder (not recorded in niara-contracts); 3M is the small-block cap |

  The Tempo demo carried explicit limits instead (`TEMPO_GAS_SETTLE` =
  2,120,000) because forge could not estimate calls that depended on earlier
  transactions of the same run; `settle` here is estimated against the
  chain as it is.
- **Chain id guard.** Every EVM entry point checks `eth_chainId` against
  the chain it expects; mainnets are not listed anywhere.
- **Adapter.** `settle(bytes16 matchId = the 16 bytes of the match UUID,
  asset, mockUSDT, buyer, seller, quantity, paymentAmount)`. Per match:
  (1) `settledMatches(matchId)` true: nothing is sent, the transaction that
  emitted the match's `Settled` event is returned (`alreadySettled`); a
  transaction this adapter already sent for the match and still pending is
  waited for, never sent again; (2) **simulate** with `eth_call` from the
  operator: a revert is never sent, and its custom error is decoded from
  the settlement's or the token's ABI (`ERC20InsufficientAllowance(...)`);
  `MatchAlreadySettled` means settled; (3) gas = estimate × multiplier,
  refused above the cap; fees per the chain's pricing; the operator must
  hold gas limit × max fee (on Tempo: its pathUSD balance, the cost
  converted from attodollars); (4) sign locally, send once, await the
  receipt (a timeout is transient and the transaction stays in flight). A
  reverted receipt re-reads the replay guard. `EnforcedPause` and RPC
  trouble are transient; a lost role is a setup error; the operator's
  missing gas is `operator_funds`.
- **Finding the settle transaction.** `Settled.matchId` is not indexed, so
  the lookup filters by the indexed asset, payment token and buyer and
  scans back from the latest block in chunks (halved when an RPC refuses
  the range), down to the deployment block. Only used for matches already
  settled on-chain (crash recovery, replays).
- **Operator key.** The `niara-evm-operator` Foundry keystore (Web3 Secret
  Storage v3, scrypt N = 8192 + AES-128-CTR), at the path niara-contracts
  uses: `~/.foundry/keystores` on Windows, reached from WSL as
  `/mnt/c/Users/<you>/.foundry/keystores/niara-evm-operator`
  (`EVM_OPERATOR_KEYSTORE`); its password in
  `EVM_OPERATOR_KEYSTORE_PASSWORD`. Decrypted once, in memory, with Node's
  crypto (MAC checked first); the file must be outside the repository. Its
  mode is not checked: the key is encrypted, and DrvFs shows every Windows
  file as 0777. Neither the password nor the key is ever logged; every
  `*PASSWORD*` variable is redacted from logs and refused in
  `NEXT_PUBLIC_*`.
- **Allowance check (the EVM equivalent of spec §3.5).** `settle` moves
  both legs with `transferFrom`, so the spender is NiaraSettlement: a sell
  order needs `allowance(wallet, NiaraSettlement)` and balance ≥ remaining
  on the asset token; a buy order the same on mockUSDT for remaining / lot ×
  limit price. Used exactly like the Solana delegate check (before matching
  and before settling). A chain refusal named `ERC20InsufficientAllowance`,
  `ERC20InsufficientBalance` or `SafeERC20FailedOperation` makes the worker
  re-check both legs to find the side at fault, as `DelegateNotSet` does on
  Solana.
- **Service.** `EVM_SETTLEMENT_CHAINS` lists the EVM chains the worker
  settles on (and checks allowances on); each must be deployed and reviewed
  in the config file, and the operator keystore and its password are then
  required. Empty by default: EVM matches stay `pending`.
- **Listing sync** (`scripts/sync-evm-listings.ts --chain <chain>`). Finds
  every token the ListingRegistry ever emitted a listing event for
  (`ListingSubmitted`, `ListingQuoted`, `ListingApproved`,
  `ListingSuspended`, `ListingDelisted`) from the deployment block, in
  chunks (halved when an RPC refuses the range), then reads each token's
  **current** state with `getListing`: the events find tokens, the contract
  decides. Then the Solana rules: Approved listings are upserted with the
  reviewed lot size (none guessed), others only get their status updated
  if mirrored, a lot size never changes under live orders, and
  `chains.settlement_program` / `quote_asset` are set (checked against
  NiaraSettlement's `feeToken` and `listingRegistry`). Addresses are stored
  checksummed; an existing row keeps its stored spelling (orders reference
  it). Unlike Solana, `listings.tx_hash` is set: the token's latest
  `ListingApproved` transaction. Dry run by default; `--apply` writes only
  when the chain is marked reviewed.
- **Nonces.** One worker, one transaction at a time, nonce from the
  `pending` count. The in-flight record is in memory: after a restart, a
  transaction still pending is not known, so a second send (next nonce) is
  possible; it can only revert `MatchAlreadySettled` once the first lands
  (gas lost, never a second settlement).

## Failed matches after both orders were filled (migration `20261120120000`)

A match fills both orders when it is made; settlement comes later and can fail
(a delegation revoked, the chain refusing, expiry). Before this migration the
innocent side's quantity was lost: `filled_quantity` cannot decrease.

- **Counters, all monotonic.** `filled_quantity` keeps its meaning (total ever
  matched). New: `settled_quantity` (settled on-chain), `released_quantity`
  (given back from failed matches, the order was not at fault),
  `voided_quantity` (lost, it was at fault). Net matched = filled − released −
  voided; remaining = quantity − net; in flight = filled − settled − released −
  voided. Status follows net matched. `filled` is no longer terminal, but the
  guard trigger lets it change only in the same update that releases or voids.
- **Audit.** `match_reversals`: one row per (failed match, order) with kind,
  fault, quantity and reason; append-only (no update or delete, for the
  service too); hidden from clients. Deferred constraint triggers check at
  commit that each order's settled/released/voided equals its settled matches
  and reversal rows, that a failed match has exactly one row per order of its
  quantity, and that a settled match has none. The worker settles the match
  and both orders' `settled_quantity` in one transaction. The service writes
  the exact engine values, so a lower value fails loudly instead of being kept.
- **Faults** (`match_fault`), chosen by the worker: `seller` / `buyer` / `both`
  (the delegate check before settling, or a chain refusal about delegation or
  funds, re-checked on-chain to find the side); `expired`; `none` (another
  refusal, or retries ran out).
- **Who gets what back** (`MatchingEngine.reverse`):
  - at fault: voided, the order becomes stale (its wallet can cancel it);
  - innocent: released, and re-enters the market at its original priority
    (seq) through the matching loop, so the book never crosses (an order that
    arrived while it was out may now cross it); if it is no longer live it
    expires; if it was cancelled, expired or stale the release is accounting
    only;
  - `expired`: both released; an order expiring at or before the match expires,
    the other re-enters;
  - `none`: both released but stale: re-entering, they would match each other
    again and fail the same way in a loop.
- **Restart.** `filled` orders with quantity in flight are restored too (out
  of the book), so a failure after a restart can still give their quantity
  back.
- **Order of rollout.** The service checks for `match_reversals` at start and
  refuses to run until the migration is applied.
- **Fixed on the way:** restore and `loadMatches` ordered by `seq::text` (the
  text output column), so with 10 or more rows seq 10 came before 2 and the
  rebuild refused the orders. Both now order by the table's numeric column; a
  regression test covers it.

## Hosting on Railway (`Dockerfile`, `docs/deploy-railway.md`)

Production testnet API at `https://api.niaraglobal.com`. Testnet only.

- **Build: a Dockerfile, no `railway.json`.** Railway no longer lets new services
  opt into config-as-code and stops reading `railway.json` / `railway.toml` on
  2026-12-01. The Dockerfile pins Node 22.23.4 and the start command; the
  healthcheck path, the replica count (1) and the restart policy are service
  settings, documented in the deploy guide.
- **Bind address and port.** Railway is detected by its injected `RAILWAY_*` ids.
  There `HOST` defaults to 0.0.0.0 (a loopback `HOST` is refused) and `PORT` is
  Railway's. Locally the default stays 127.0.0.1:8787.
- **Keys from variable content.** `SOLANA_OPERATOR_KEYPAIR_JSON`,
  `EVM_OPERATOR_KEYSTORE_JSON` (+ password), next to the file-path variables
  for local use; both forms at once is refused. The content is redacted in
  every printable form (raw, re-serialized, base58/hex/base64 of the key and
  seed, the keystore's secret fields) and never appears in the logged config.
  On a host, a key is only as safe as the host account: acceptable for devnet
  and testnet keys, not for mainnet (KMS/HSM).
- **Database TLS.** Supabase's root CA is public and committed
  (`config/supabase-ca.crt`); it is the default `sslrootcert`. `sslmode` must be
  `verify-full`. Railway connects through Supabase's session-mode pooler
  (IPv4, port 5432, keeps the session lock); the direct host is IPv6-only.
- **Rate limiting.** In-memory per-IP token buckets (the service is one
  process): 300/min reads, 30/min POST by default. The client IP is Railway's
  `X-Real-IP` only (`TRUST_PROXY=railway`, forced on Railway); `X-Forwarded-For`
  is never read, because a client controls it. Railway documents that its edge
  sets `X-Real-IP` but not that it replaces a client's copy: the deploy guide
  has a one-time spoofing check. IPv6 is limited per /64. 429s carry the CORS
  header so the site can show them.
- **CORS.** Production origins `https://niaraglobal.com` and
  `https://www.niaraglobal.com`. Besides `*` and wildcards, plain `http://`
  origins are now refused except for localhost.
- **Redeploys and the single-instance lock.** Railway starts the new deployment
  before stopping the old one, and stops the old one only after the new one
  passes `/health`. Refusing to start on a taken lock would therefore fail
  every redeploy. A starting instance now waits in standby: `/health` answers
  200 "standby" and the API 503 `starting`. It waits up to
  `INSTANCE_LOCK_WAIT_SECS` (600 on Railway, 0 locally) and serves once the
  lock is its. The lock remains the only way to serve or settle. The cost is a
  few seconds of 503s per redeploy. A second replica would only ever stand by
  (and receive traffic it answers with 503), so replicas must stay at 1.
  Everything that can fail on a bad configuration runs before the service
  listens, so a bad deploy fails before it goes live: database connection and
  TLS, RPC chain checks, operator keys.

## Time in force and market orders (intent v2, migration `20261124120000`)

- **IOC** (immediate or cancel): matched at once against the book, at the
  makers' prices, never beyond the signed limit price; whatever is not matched
  is cancelled with `cancel_reason = 'ioc_unfilled'`. An IOC **never rests**:
  not at placement, and not later. Self-trade prevention and the minimum
  notional apply as to any taker (their reasons win when they cut the order
  first); a remainder below the minimum is cancelled as `ioc_unfilled`, since
  it was never going to rest.
- **Failed matches.** An innocent IOC whose match fails gets its quantity
  back as `released`, and that quantity is cancelled (`ioc_unfilled`) instead
  of re-entering the book: re-entering minutes later would not be
  "immediate". An IOC at fault becomes stale, as any order. A filled IOC is
  kept in memory after a restart (a failed match may still release it);
  `restore` refuses an IOC in a resting status.
- **Market order** = an IOC whose signed limit price is a **price cap** the
  client sets from the best opposite price: best ask + slippage for a buy
  (rounded down), best bid - slippage for a sell (rounded up, at least 1).
  **Recommended default 1%, maximum 5%** (`marketOrderLimitPrice`,
  `src/intents/market-order.ts`, refuses more and refuses an empty opposite
  side). The engine knows nothing of slippage and enforces only the signed
  limit, so the cap the wallet sees and signs is the worst price it can get.
- **Approvals.** An IOC buy must be covered for `quantity / lot_size x
  limit_price`, the cap, not the expected price; a sell for its quantity
  (`requiredApproval` = the service's `orderNeed`). Settlement pulls each
  match's `payment_amount` at the maker's price, within the approval. The
  unused allowance (unfilled part, and the gap between the cap and the prices
  paid) is **not reused**: the client approves exactly each order's amount, and
  an approval replaces the previous one (SPL and ERC-20 `approve`), so the next
  order overwrites it; the engine never comes back to an IOC, so nothing counts
  it for that order again. The allowance stays on-chain until then; a wallet
  that wants it gone revokes it.
- **Schema.** `orders.time_in_force` (`gtc`, `ioc`), not null, default `gtc`
  (existing rows, and inserts by a service built before it); immutable like
  the other signed fields. Checks: an IOC is never `open` or
  `partially_filled`; `ioc_unfilled` only on IOC orders; `intent_version = 1`
  implies `gtc`. The new enum value is compared as text only, so the file
  applies in one transaction. Not granted to `anon`/`authenticated`.
- **Deploy order.** Apply the migration, then deploy. The service requires it
  (`REQUIRED_MIGRATIONS`) and checks before listening, so a deployment that
  lands first exits without ever answering `/health` and the previous one
  keeps serving; the previous build keeps working on the migrated schema.

## Iceberg orders (intent v3, migration `20261127120000`)

An iceberg shows only part of its quantity in the book at a time (spec §9.13,
decided for v1). The visible slice is the wallet's decision, so it is signed:
the operator can never show more than the wallet allowed.

- **Intent v3** = v2 + `displayQuantity`, in **asset base units, a whole
  number of lots** (the unit of `quantity`, so the two compare directly).
  Rules, checked at admission (`src/intents/validate.ts`): GTC only (an IOC
  never rests, so it has nothing to hide: `iceberg_requires_gtc`); at least
  one lot, a multiple of the lot size, and less than `quantity`
  (`invalid_display_quantity`; an order shown whole is a v2 order). A v3
  intent is always an iceberg. The engine adds the market check: the display
  quantity at the limit price must meet the chain's minimum order value
  (`display_below_min_notional`). `INTENT_VERSION` stays 2 (plain orders);
  `ICEBERG_INTENT_VERSION` is 3.
- **Solana text**: first line `Niara Exchange order intent v3`, and one line
  after `Time in force`: `Display quantity: <n> (asset base units shown in the
  book at a time)`. The rest is v2's text. 699 bytes for a typical intent
  (43-character addresses, a 7-digit display; v1 552, v2 626), and one more
  byte per extra digit of the display.
- **EIP-712**: same domain, same primary type name, a third type hash:
  `OrderIntent(address wallet,uint8 side,address asset,uint256 quantity,uint256 lotSize,uint256 limitPrice,address paymentAsset,bytes16 nonce,uint64 expiresAt,uint8 timeInForce,uint256 displayQuantity)`
  (`timeInForce` is always 0 = GTC in v3). No contract or program change: as
  for v2, nothing verifies intents on-chain yet; the signed-intents milestone
  must rebuild all three versions.
- **The cancellation keeps its own version (1)**: it names the order by nonce,
  which an iceberg has like any order.

**Matching** (`src/engine/engine.ts`):

- As a **taker**, an iceberg matches its whole remainder (hidden part
  included), like any order. Only what rests is sliced.
- **Resting**, only the visible slice, min(display, remaining), is in the book
  and can be matched. A taker takes at most that slice from it, then moves on.
- **Refresh.** When a slice is fully filled and quantity remains, a new slice of
  min(display, remaining) is shown at the same price with a **new time
  priority**: the next value of the engine's arrival sequence, so it sorts
  behind every order already resting at that price. The same taker can fill
  several refreshed slices in one pass while it is still marketable, taking
  the orders in between in price-time order.
- **A partly filled slice keeps its priority.** If what is left of it is worth
  less than the minimum order value while hidden quantity remains, it is
  refreshed the same way (new slice, new priority) instead of resting below
  the minimum. The last slice is the remainder, under the remainder rule: a
  remainder below the minimum is cancelled (`below_min_notional`), as for any
  order. An iceberg whose full slice is below a minimum raised since it rested
  is cancelled (`below_min_notional`) when matching reaches it, rather than
  shown larger than its display.
- Unchanged: self-trade prevention (cancel newest), whole lots, the maker's
  price as the trade price, the minimum value of every match.
- **Cancel, expiry, stale** take the whole order out (visible and hidden).
- **Failed match.** An innocent iceberg re-enters at the priority it had and
  shows a full slice again; at fault it becomes stale, as any order.
- **Restart.** `orders.visible_quantity` and `orders.priority_seq` are written
  with every state change; `restore` rebuilds each book in (price, priority)
  order. The next arrival sequence continues after the highest of `seq` and
  `priority_seq`.
- **Delegate pre-check.** `uncoveredMakers` counts an iceberg for its visible
  slice only: the incoming order may reach the orders resting behind it before
  the next slice, so they are checked too. Each maker's own check still covers
  its whole remainder.

**Settlement and approvals.** Each fill settles as today. The approval (SPL
delegation, ERC-20 allowance) must still cover the **whole remaining
quantity**, hidden part included: the service checks `remaining`, not the
slice.

**Honest limit.** The on-chain approval is public: anyone can read a wallet's
delegation or allowance and see up to the total it may trade. An iceberg hides
its size from the book, not from the chain. Fills are public too once settled.

**Privacy of the read paths** (audited; `test/service/iceberg.test.ts` checks
that none shows the total or the remainder):

| Read path | Who | What an iceberg shows |
|---|---|---|
| `GET /v1/books/:chain/:asset` | public | the visible slice, inside its price level |
| `order_book` view (Supabase, anon/authenticated) | public | the visible slice (`sum(book_quantity)`) |
| `orders` table (anon/authenticated) | public | live orders' price-level columns and `book_quantity` only; `quantity`, `filled_quantity`, `released_quantity`, `voided_quantity`, `display_quantity`, `visible_quantity`, `priority_seq` are not granted |
| `GET /v1/orders?chain=&wallet=`, `GET /v1/orders/:id` | public (unsigned; order ids reach the counterparty through matches) | `quantity` and `remaining` are `null`; `displayQuantity`, `visibleQuantity` (0 once out of the book) and the fill counters are shown |
| `GET /v1/matches...`, `GET /v1/trades...` | public | fills only (public on-chain once settled) |
| `POST /v1/orders`, `POST /v1/orders/cancel` answers | the wallet (signed request) | the total and the remainder |
| WebSocket | none exists | |

The wallet's own total: the only signed answers are the placement and the
cancellation. The site keeps the total from the intent the wallet signed and
computes the remainder as quantity - (filled - released - voided), all of
which the public view shows except the quantity. A wallet-signed read of a
wallet's own orders belongs with the mainnet sign-in above.

**Schema** (`20261127120000_iceberg_orders`):

- `display_quantity` (signed, immutable in `orders_guard_update`), checks:
  only with `intent_version >= 3`, `time_in_force = 'gtc'`, at least 1, below
  `quantity`, a multiple of `lot_size`; a v3 row is an iceberg.
- `visible_quantity`: present exactly for icebergs, at most the display, and
  while the order rests, positive and within its remainder.
- `priority_seq`: icebergs only, later than `seq`, unique, and it only moves
  later (guard). Null until the first refresh.
- `book_quantity`, generated: `visible_quantity` for an iceberg, the remaining
  quantity otherwise. It is what `anon`/`authenticated` read now. **Change for
  direct PostgREST readers of `orders`**: `quantity` and the fill counters are
  no longer readable by them (`order_book` keeps its columns; the site reads
  only `order_book`).
- **Deploy order.** Apply the migration, then deploy. The service requires it
  (`REQUIRED_MIGRATIONS`); the previous build keeps working on the migrated
  schema (it writes no iceberg, and `book_quantity` is generated).

## Not done yet

- HyperEVM testnet: no v1 deployment yet; its settings are in the config
  file (legacy gas, 3M small-block cap) but the adapter refuses it.
- EVM: no replacement or speed-up of a stuck transaction (same nonce, higher
  fee); a settlement left pending past its receipt timeout is retried by the
  worker and waited for, but never repriced.
- A `none` failure leaves both orders stale; nothing re-offers them
  automatically (an operator or the wallets decide).
- A stale order never returns to the book (spec §5 allows
  `stale → open`); its wallet can cancel it and place a new one.
- Aggregate delegations: several open orders of one wallet on one mint are
  each checked against the whole delegation, not against their sum.
- The engine keeps every order it has seen since start in memory (terminal
  ones too); fine for testnet volumes, to prune before real traffic.
- The match ids made before a restart are not reloaded into the engine's
  duplicate check; a repeated UUID v4 would hit the primary key, fail the
  transaction and restart the service.
- A wallet cannot read its own iceberg's total from the API after placement
  (only the signed placement and cancellation answers show it); a
  wallet-signed read is the mainnet sign-in's work.
- On-chain cancellation (`cancel_intent` on Solana, a `cancelled` mapping on
  EVM) waits for the on-chain signed-intents milestone; until then a
  cancellation is enforced off-chain, and recorded in `orders.cancel_reason`
  and `orders.cancel_signature`.
- Advisory lock contention between two processes is not tested against a
  real server (PGlite is one session). The `pg` adapter and `set local role
  service_role` were checked read-only against the remote database.

## Spec edits applied

The nine edits proposed in the first round are in the spec
(`niara-exchange-solana`, commits `6b04af5` to `c6fbfff`), grouped here by spec commit:

| Proposal | Spec commit |
|---|---|
| §3.5: the off-chain service, not the engine, checks delegates and marks orders stale | `6b04af5` |
| §3.6: intent format (signed fields, Solana text, EIP-712 domain and type); OpenZeppelin `ECDSA` instead of a bare `ecrecover` | `74e2b99` |
| §3.6: `register_intent` (two text intents do not fit one transaction) and cumulative filled quantity per intent, as the on-chain milestone; the operator stays a documented trust assumption until then | `56ec9f7` |
| §2: `Match` defined | `2377ef8` |
| §5: the migration's schema and units | `afb48c7` |
| §9.12 item 2: validity window, 17-byte `SettlementRecord`, closing only after on-chain intent verification | `b8949a8` |
| §9.12 item 1: minimum checked at admission and at match time, remainder below it cancelled | `c6fbfff` |

The second round (items 12 to 16 of "Spec edits needed", both groups that
carried those numbers) is in the spec as of `niara-exchange-solana` `ed7d32c`:

| Proposal | Spec commit |
|---|---|
| §3.4 / §2: EVM `matchId` is `bytes16` (the match UUID's 16 bytes); the replay key is `settledMatches[bytes16]` | `cb8ac71` |
| §3.5: the delegate check's EVM form (`allowance(wallet, NiaraSettlement)` and balance on each leg's token; no vault) | `d44a1e6` |
| Contracts: `Settled.matchId` indexed, deferred to the next contract version (contracts v2, pre-mainnet in §9.13) | `cb8ac71` |
| §3.6: order intent v2 signs `timeInForce` (Solana text line, EIP-712 `uint8 timeInForce`); v1 stays valid as GTC | `c9a822e` |
| §3.6: the cancellation keeps its own version (1) | `c9a822e` |
| §2 / §5: market order = IOC with a client-set price cap; an IOC never rests and is not re-entered after a failed match | `867b9d2` |
| §5: `orders.time_in_force`, `ioc_unfilled`, and the cancellation audit trail as built (migrations `20261120130000`, `20261124120000`) | `04863d5` |
| §3.5: an IOC buy is covered by `quantity / lot_size x limit_price`; its unused allowance is not reused | `d44a1e6` |

## Spec edits needed

These go to `niara-exchange-solana`, which owns the spec.

1. **§3.6, cancellation format.** Record the signed cancellation (Solana text
   and EIP-712 `CancelOrder(address wallet,bytes16 nonce)` above), bound to
   chain, program/contract, wallet and the order's nonce, and that it is
   enforced off-chain only. The on-chain milestone then needs an on-chain
   cancel: once an intent is registered (`["intent", wallet, nonce]` on
   Solana) or carried with `settle` (EVM), an off-chain cancellation does not
   stop the operator from settling it. Proposal: a wallet-signed
   `cancel_intent` that marks the intent account cancelled on Solana, and a
   `cancelled[wallet][nonce]` mapping set by the wallet on EVM; until then,
   revoking the delegate or allowance is the wallet's on-chain guarantee.
2. **§5, "a server function".** Orders (and cancellations) enter through a
   **single-instance Node order service** (`niara-exchange-engine`,
   `src/service`), not a Supabase function: it connects to Postgres directly,
   writes as `service_role`, and holds a Postgres advisory lock so that only
   one instance matches. Suggest replacing "a server function" with that, and
   noting that the matching engine's state is rebuilt from `orders` on start.
3. **§5, `seq`.** `orders.seq` and `matches.seq` are assigned by the engine
   and stored as is (they are the engine's time priority and match sequence),
   not by the database.
4. **§9.12 item 1, which order is cancelled.** "A match below the minimum is
   not made" leaves open what happens to the two orders. Proposal: the order
   whose remainder limits the match is cancelled (the resting one, and
   matching continues; or the incoming one, and matching stops); the engine
   never skips the best price to reach a larger match. This covers resting
   orders left below a raised minimum. The founder confirmed this rule as
   final on 2026-11-20.
5. **§5, cancellation audit trail.** Record `orders.cancel_reason`
   (`by_wallet`, `self_trade_prevention`, `below_min_notional`, `expired`,
   `stale`, tied to the status) and `orders.cancel_signature` (the wallet's
   signature, present exactly for `by_wallet`), as in migration
   `20261120130000_cancel_reasons`.
6. **§2 `SettlementAdapter`.** `settle` returns `{ txHash, alreadySettled }`
   (`alreadySettled`: the replay guard already existed, nothing was sent,
   `txHash` is the transaction that created it), and the interface gains
   `findSettlement(match): Promise<string | null>` (sends nothing).
7. **§3.5, both legs.** The delegate check covers the buyer's USDT
   delegation too: `settle` refuses a buyer whose payment account does not
   delegate (`DelegateNotSet` / `InsufficientDelegation` on that leg). A buy
   order is covered by `remaining / lot_size × limit_price`.
8. **§3.4, token accounts.** Settlement uses the parties' associated token
   accounts; the signed intent names wallets, not token accounts.
9. **§2 and §5, expiry at settlement.** "A match never settles after
   `expiresAt`" is enforced off-chain only until `settle` checks the window:
   the worker does not send within 90 s of `expires_at` (a sent transaction
   can land up to a blockhash lifetime later) and fails the match instead.
10. **§5, failed matches after matching.** Replace the open question with the
    design above (migration `20261120120000`): the counters and their meaning,
    `match_reversals` as the audit trail, the five faults, and who gets the
    quantity back (innocent side re-enters through matching at its original
    priority; the side at fault is voided and stale; `none` leaves both
    stale).
11. **§5, settlement statuses.** Record the meanings: settlements `pending`
    (created or waiting for a retry), `submitted` (handed to the chain),
    `confirmed` (tx hash), `failed` (error); matches `settling` while an
    attempt is in flight.
12. **§3.6, order intent v3 (iceberg).** Add `displayQuantity` to the signed
    fields of an iceberg: asset base units shown in the book at a time, a
    whole number of lots, at least one lot, less than `quantity`; GTC only.
    Solana text: header `Niara Exchange order intent v3` and, after the
    `Time in force` line, `Display quantity: <n> (asset base units shown in
    the book at a time)`; 699 bytes for a typical intent (v1 552, v2 626),
    one more per extra digit of the display, so one v3 text still fits one
    transaction with its Ed25519 instruction (two do not, as for v1). EIP-712:
    same domain and primary type name, type
    `OrderIntent(address wallet,uint8 side,address asset,uint256 quantity,uint256 lotSize,uint256 limitPrice,address paymentAsset,bytes16 nonce,uint64 expiresAt,uint8 timeInForce,uint256 displayQuantity)`.
    A v3 intent is always an iceberg; v1 and v2 stay valid and are shown
    whole; the cancellation keeps its version 1. The on-chain signed-intents
    milestone must rebuild all three versions. No program or contract change.
13. **§2, iceberg matching rules.** As a taker an iceberg matches its whole
    remainder; resting, only its visible slice, min(display, remaining), is
    in the book and can be matched. A fully filled slice is refreshed at the
    same price with a new time priority (the next arrival sequence: behind
    every order already resting), and one taker can fill several refreshed
    slices in one pass while it is still marketable. A partly filled slice
    keeps its priority, unless what is left of it falls below the minimum
    order value while hidden quantity remains: then it is refreshed the same
    way. The display quantity must meet the minimum order value at the limit
    price (refused otherwise); the last slice is the remainder, under the
    remainder rule of §9.12 item 1; an iceberg whose full slice falls below a
    raised minimum is cancelled (`below_min_notional`) rather than shown
    larger than its display. Self-trade prevention, lot units, the maker's
    price and the minimum value of every match are unchanged. An innocent
    iceberg re-entering after a failed match keeps its last priority and
    shows a full slice.
14. **§5, iceberg schema and the public view** (migration
    `20261127120000_iceberg_orders`, answering §9.13 item 2's open question).
    `orders.display_quantity` (signed, immutable; only with
    `intent_version >= 3`, GTC, at least 1, below `quantity`, whole lots),
    `orders.visible_quantity` (the current slice), `orders.priority_seq` (the
    slice's priority after a refresh, from the same sequence as `seq`; only
    moves later; unique) and the generated `orders.book_quantity` (the slice
    of an iceberg, the remainder of any other order). The public
    `order_book` view sums `book_quantity`: **visible slices only**, same
    columns as before. `anon`/`authenticated` no longer read
    `orders.quantity` or the fill counters (they would show the hidden
    quantity), only the price-level columns and `book_quantity`. The service's
    unsigned order reads show `null` quantity and remainder for an iceberg.
15. **§3.5, iceberg approvals and their privacy limit.** An iceberg is covered
    for its whole remainder (hidden part included), as any order; each fill
    settles as today. The approval (SPL delegation, ERC-20 allowance) is
    public, so an observer can read up to the total an iceberg may trade:
    **an iceberg hides size from the book, not from the chain**. Fills are
    public once settled.
16. **§9.13 item 2.** Mark iceberg orders done, pointing to items 12 to 15.

