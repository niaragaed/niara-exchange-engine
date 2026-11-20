# niara-exchange-engine

> **Testnet only.** No real assets, no real money, no regulatory authorization.

Off-chain side of the Niara Exchange (design spec:
`niara-exchange-solana/EXCHANGE-MULTICHAIN-DESIGN.md`, §2, §3.6, §5): wallets
sign order intents, the order service admits them and the matching engine
pairs `Equity` orders per (chain, asset), and the settlement worker settles
each match on-chain through a `SettlementAdapter`: **Solana devnet**, and the
EVM testnets **Base Sepolia, Robinhood Chain testnet and Tempo testnet**
(HyperEVM testnet once deployed). An EVM chain settles only when it is listed
in `EVM_SETTLEMENT_CHAINS` and marked reviewed in `config/evm-testnets.json`;
otherwise its matches stay `pending`.

Matching is off-chain and centralized by design; settlement is atomic and
on-chain. This is not a decentralized exchange.

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
```

See `CLAUDE.md` for the repo rules and `docs/decisions.md` for the design
decisions made on top of the spec.

## Database

Supabase project `niara-exchange-dev` (Postgres 17). Migrations live in
`supabase/migrations` and are tested here against PGlite (in process).

| Migration | Remote `niara-exchange-dev` |
|---|---|
| `20261116120000_exchange_schema` | **Applied** (by the founder, through the Supabase dashboard tooling) |
| `20261116130000_fk_indexes` | **Applied** (by the founder; `matches_chain_asset_idx` seen on the remote on 2026-11-16) |
| `20261120120000_match_reversals` | **Applied** (by the founder; seen in `supabase_migrations.schema_migrations` on 2026-11-20). Failed matches after both orders were filled: settled/released/voided counters and the `match_reversals` audit table |
| `20261120130000_cancel_reasons` | **Not applied.** `orders.cancel_reason` and `orders.cancel_signature`, written on every cancellation, expiry and stale. The order service refuses to start until it is applied |

- The obsolete September prototype was moved to the schema
  `legacy_prototype_2026_09`, outside the API. This repo only uses `public`.
- **Never apply migrations to the remote from this repo** (no
  `supabase db push`, no migration tooling against the project). Schema
  changes are written here, tested on PGlite and applied by the founder.
- **Data writes** to `niara-exchange-dev` go through the order service, its
  worker and the listing sync (`--apply`), as `service_role`.

## Order service

`src/service`: one Node process with an HTTP API (Hono).

| Endpoint | Body | |
|---|---|---|
| `POST /v1/orders` | `{ intent, signature }` | Submit a signed order intent (Solana `signMessage` text or EIP-712) |
| `POST /v1/orders/cancel` | `{ cancel, signature }` | Cancel an order with a signed cancellation (by chain, wallet and nonce) |
| `GET /v1/books/:chain/:asset` | | Public book: price levels only |
| `GET /v1/matches/:id` | | A match's settlement status and tx hash (no wallets) |
| `GET /health` | | Liveness, with the testnet notice |

Amounts are decimal strings in JSON (base units: quantity in asset base
units, price in USDT base units per lot). Formats: `docs/decisions.md`.

**Run exactly one instance.** Matching state lives in the process, so two
instances would match the same orders twice. The service enforces it: on
start it takes a Postgres advisory lock on its single database connection,
and a second instance finds the lock taken and exits with
`refused_to_start`. If the connection drops, the lock is released with it,
so the process exits too; let the supervisor restart it (it rebuilds the
books from the open orders in the database, in their original sequence).
Use the direct or session-mode connection (port 5432): the transaction
pooler (port 6543) cannot hold the lock and is refused.

```bash
cp .env.example .env   # git-ignored; fill in DATABASE_URL (secret)
npm start              # node --env-file=.env src/service/main.ts
```

Configuration is environment variables only (`.env.example`). Every value is
server-only: the service refuses to start if a `NEXT_PUBLIC_*` variable names
or contains a server secret. It connects to Postgres directly and writes as
`service_role`; it does not use the Supabase service role key.

The settlement worker runs in the same process (so the lock also makes it the
only worker). It needs the Solana settlement operator's keypair **path**
(`SOLANA_OPERATOR_KEYPAIR`, a file outside the repo, mode 600); without it set
`WORKER_ENABLED=off` and matches stay `pending`. For the EVM chains of
`EVM_SETTLEMENT_CHAINS` it also needs the EVM operator's Foundry keystore path
(`EVM_OPERATOR_KEYSTORE`) and its password (`EVM_OPERATOR_KEYSTORE_PASSWORD`).

Tests run on PGlite with the real migrations and a mocked Solana RPC; the
`pg` adapter was checked read-only against the remote database.

## Solana devnet

Program `B311xH3PcEx86gdRbuinrGrh1r9G2qzjDCji8uc6eD9v` (IDL vendored in
`src/solana/idl`). Devnet only: every Solana entry point checks the RPC's
genesis hash.

```bash
# 1. Mirror the program's listings (read-only on-chain). Dry run first; --apply
#    writes, and only once config/solana-devnet.json is marked "reviewed": true.
node --env-file=.env scripts/sync-solana-listings.ts
node --env-file=.env scripts/sync-solana-listings.ts --apply

# 2. Run the service and its worker (single instance).
npm start

# 3. End-to-end on devnet, in another terminal (writes to devnet: one approval
#    transaction and one settle). Log in ~/niara-logs/.
node --env-file=.env scripts/e2e-devnet.ts
```

Before matching and before settling, the service checks on-chain that each
order's wallet delegates enough to the program's vault PDA and holds enough
(sellers: the asset; buyers: USDT). An uncovered resting order is marked
`stale`.

## EVM testnets

`NiaraSettlement.settle` on Base Sepolia (84532), Robinhood Chain testnet
(46630) and Tempo testnet (42431), at the addresses of the niara-contracts v1
deployments (`config/evm-testnets.json`, with each value's source; the three
chains share addresses). HyperEVM testnet (998) has no deployment yet. Every
EVM entry point checks the node's chain id; ABIs are vendored in
`src/evm/abi`.

- **Settlement.** The replay record (`settledMatches(bytes16)`) is read
  before every send, and `settle` is simulated before every send; gas is the
  node's estimate times the chain's multiplier (Base 1.3, Robinhood 2, Tempo
  2 with the fee paid in pathUSD as a Tempo `0x76` transaction; HyperEVM
  legacy pricing). `matchId` is the match UUID's 16 bytes.
- **Allowance check** (the EVM delegate check): before matching and before
  settling, each side must have approved NiaraSettlement for, and hold, its
  leg (sellers the asset, buyers mockUSDT). An uncovered resting order is
  marked `stale`.
- **Operator key.** The `niara-evm-operator` Foundry keystore, read from the
  Windows keystore directory niara-contracts uses
  (`/mnt/c/Users/<you>/.foundry/keystores/niara-evm-operator` from WSL), with
  its password from `.env`. Decrypted in memory; never printed.
- **Before enabling a chain:** review its entry in `config/evm-testnets.json`
  and set `"reviewed": true`, then add it to `EVM_SETTLEMENT_CHAINS`.

```bash
# Mirror a chain's ListingRegistry listings (read-only on-chain: eth_call and
# eth_getLogs from the deployment block). Dry run first; --apply writes, and only
# once the chain is marked reviewed in config/evm-testnets.json.
node --env-file=.env scripts/sync-evm-listings.ts --chain base-sepolia
node --env-file=.env scripts/sync-evm-listings.ts --chain base-sepolia --apply
```
