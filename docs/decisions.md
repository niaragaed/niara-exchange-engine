# Design decisions

Decisions this repo makes on top of the spec
(`niara-exchange-solana/EXCHANGE-MULTICHAIN-DESIGN.md`). The spec is the
source of truth; where a decision here needs the spec to change, it is
listed under "Spec edits proposed" at the end.

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
(16 random bytes) and **expiry** (unix seconds, required).

- **Solana**: a fixed, labeled UTF-8 text with the testnet notice, signed with
  `signMessage` (552 bytes for a typical intent). The verifier rebuilds the
  text from the structured intent and never parses signed text. Strict
  ed25519 (`zip215: false`), like the Ed25519 program's `verify_strict`.
- **EVM**: EIP-712. Domain `{ name: "Niara Exchange", version: "1", chainId,
  verifyingContract: NiaraSettlement }`; type
  `OrderIntent(address wallet,uint8 side,address asset,uint256 quantity,uint256 lotSize,uint256 limitPrice,address paymentAsset,bytes16 nonce,uint64 expiresAt)`
  with `side` 0 = buy, 1 = sell. Only 65-byte, `v` 27/28, low-s signatures,
  as OpenZeppelin `ECDSA`.
- **Amounts** must fit the on-chain width: u64 on Solana (including the
  notional, which becomes `payment_amount`), uint256 on EVM. In JSON they are
  decimal strings only.
- **Expiry window**: the server refuses `expiresAt <= now` and
  `expiresAt > now + chains.max_intent_validity_secs` (default 30 days, the
  same as the P2P deal limit `MAX_DEAL_DURATION_SECS`).
- **Nonce**: unique per (chain, wallet) (`orders` unique constraint), so a
  signed intent can enter the book only once.
- `admitOrderIntent` is the core of the server function that inserts orders.
  Market checks (approved equity, lot size, minimum notional) stay in the
  engine.

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
- Minimum order notional (spec §9.12 item 1) is checked at order entry.

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
  signatures. They write nothing. The service role (the signature-verifying
  server function and the worker) inserts and updates; nobody deletes.
- Tested against PGlite 0.4.6 (Postgres 17.5 in WASM, in process). The
  migration is not applied to any Supabase project.

## Tooling

TypeScript 7.0.2 (strict), vitest 5.0.5 with one worker, fast-check 4.10.2,
@noble/ed25519 3.2.0, @scure/base 2.4.0, viem 2.57.14, all pinned exactly.
`.npmrc` sets `legacy-peer-deps` because npm 10 crashes resolving vitest 5's
optional peer chain; `vite` and `@types/node` are pinned directly instead.

## Not done yet

- **Signed cancellation**: the engine cancels for an authenticated wallet,
  but the message a wallet signs to cancel (by nonce) is not defined yet.
- The server function itself (HTTP endpoint and database writes) and the
  engine ↔ database glue (rebuilding books from `orders` on start).
- Settlement adapters and the worker (stub that refuses to run).
- A partial fill can leave a remainder, and produce a match, below the
  minimum order notional.

## Spec edits proposed

These go to `niara-exchange-solana`, which owns the spec.

1. **§5 schema**: replace the minimal schema with the one in the migration
   (chains table; lot-based units; `filled_quantity`, `seq`, `nonce`,
   `expires_at`, `intent_version` on orders; `payment_amount`, `maker_order`,
   `expires_at` on matches; status enums; RLS summary). State the price unit:
   USDT base units per lot.
2. **§2 `Match`**: the spec names `Match` without defining it. Propose the
   fields of `src/engine/types.ts` (`id` = UUID v4 = `match_id`, buyer,
   seller, `quantity` = `asset_amount`, `paymentAmount` = `payment_amount`,
   `expiresAt`).
3. **§3.6 intent format**: record the signed fields, the Solana text and the
   EIP-712 domain and type above, and the low-s / strict-ed25519 rules.
4. **§3.6 Solana on-chain verification does not fit in one `settle`
   transaction.** Two text intents in Ed25519 instructions are about 1,330
   bytes (2 × (552 + 64 + 32 + 16)), over the 1,232-byte transaction limit
   before `settle`'s own accounts. Proposal: a `register_intent` instruction
   verifies one intent (its own transaction) and creates an
   `["intent", wallet, nonce]` account; `settle` reads the two intent
   accounts. The alternative is a compact binary message, which wallets show
   as unreadable bytes.
5. **§3.6 cumulative fills.** Checking each match against the signed intents
   does not stop the operator from filling one intent several times through
   different match ids, as long as the delegate/allowance covers it (and with
   aggregate approvals, §3.5, it can). On-chain verification needs a per-intent
   filled amount (the `["intent", wallet, nonce]` account above on Solana, a
   `filled[intentHash]` mapping on EVM). That account costs rent too (§9.12).
6. **§9.12 item 2, the window**: the signed timestamp is the intent's
   `expiresAt`; a match expires with the earlier of its two intents; the
   maximum window is per chain (`max_intent_validity_secs`, proposed
   30 days), enforced off-chain now and later on-chain as a `Config` field
   changed through the timelock. `settle` would check
   `now < expires_at <= now + window`. `SettlementRecord` would store
   `expires_at` (9 → 17 bytes: the rent figure must be measured again), and
   `close_settlement` would accept records with
   `now >= expires_at + margin`. Closing is replay-safe only once `settle`
   verifies the signed intents on-chain; until then the operator supplies
   `expires_at` and could replay a closed id.
7. **§9.12 item 1**: say whether the minimum applies to orders, to matches,
   or to both. Orders are checked at entry here; partial fills can still
   produce smaller matches.
8. **§3.5 "the matching engine must check `delegate` … on-chain"**: the
   engine is pure; the off-chain service does the check (before matching and
   before settling) and marks the order stale (`markStale`). Suggest
   rewording to "the off-chain service".
9. **§3.6 "EVM: verified with `ecrecover`"**: suggest "EIP-712, verified
   with OpenZeppelin `ECDSA` (low-s, `v` 27/28)", since a bare `ecrecover`
   accepts malleable signatures.
