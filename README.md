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
| `20261120130000_cancel_reasons` | **Applied** (by the founder, 2026-11-22). `orders.cancel_reason` and `orders.cancel_signature`, written on every cancellation, expiry and stale |
| `20261122120000_listing_metadata` | **Applied** (by the founder, 2026-11-22). `listings.symbol` and `listings.name`, from each token's on-chain metadata, filled by both listing syncs |

The order service refuses to start while a migration it writes through is missing, and names it.

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
| `GET /v1/orders?chain=&wallet=` | | A wallet's orders, newest first, with nonces (unsigned: testnet only) |
| `GET /v1/orders/:id` | | One order's current state, its matches and their settlements |
| `GET /v1/matches?chain=&wallet=` | | A wallet's matches with settlement status and tx hash (unsigned: testnet only) |
| `GET /v1/matches/:id` | | A match's settlement status and tx hash (no wallets) |
| `GET /v1/trades/:chain/:asset` | | Settled trades of a market (no wallets), for history and candles |
| `GET /v1/markets` | | Chains (orders accepted? settlement enabled?) and their approved equity markets |
| `GET /v1/books/:chain/:asset` | | Public book: price levels only |
| `GET /health` | | Liveness, with the testnet notice |

Lists page with `limit` and `before` (the `next` cursor of the previous page).
Browsers may call the API only from the exact origins in `CORS_ORIGINS`.

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

### Running it for a browser test of the site (`niara-site`, http://localhost:3000)

In your own Ubuntu (WSL) terminal, with `.env` holding `DATABASE_URL`,
`WORKER_ENABLED=on`, `SOLANA_OPERATOR_KEYPAIR`, `EVM_SETTLEMENT_CHAINS=base-sepolia`,
`EVM_OPERATOR_KEYSTORE`, `EVM_OPERATOR_KEYSTORE_PASSWORD` and
`CORS_ORIGINS=http://localhost:3000`:

```bash
cd ~/niara-exchange-engine
mkdir -p ~/niara-logs
npm start 2>&1 | tee ~/niara-logs/service-$(date -u +%Y%m%dT%H%M%SZ).log
```

It runs in the foreground: leave that terminal open. It is up once it logs
`listening` and one `worker_starting` line per chain (`solana-devnet`,
`base-sepolia`). From a second terminal:

```bash
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/v1/markets          # settlementEnabled true for solana-devnet and base-sepolia
curl -si -X OPTIONS http://127.0.0.1:8787/v1/orders \
  -H 'Origin: http://localhost:3000' -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' | grep -i '^access-control-allow-origin'
```

The last one must print `access-control-allow-origin: http://localhost:3000`.
The service listens on 127.0.0.1 only; a browser on Windows reaches it through
WSL's localhost forwarding at http://localhost:8787.

Stop it with **Ctrl+C** in its terminal (it logs `stopping` and releases the
single-instance lock). If the terminal is gone: `pkill -INT -f src/service/main.ts`,
then `ss -ltn | grep 8787` must print nothing. A second `npm start` while one is
running exits with `refused_to_start` (the advisory lock).

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

### Browser test on devnet: funding a tester (`scripts/fund-tester.ts`)

Sends a tester's own wallet devnet SOL, mockUSDT and tEQTY in ONE devnet transaction
(simulated first): the demo funder sends the SOL and pays the fees and the rent of
the tester's token accounts (created if missing); the demo "equity-seller" wallet
sends the tokens. Keys stay in `~/.config/niara-exchange/devnet/` and are never
printed. The address must be a wallet (on curve) and not one of the demo keys;
amounts are capped (1 SOL, 10,000 mockUSDT, 100 tEQTY).

```bash
node --env-file=.env scripts/fund-tester.ts <address> --dry-run      # reads and simulates, sends nothing
node --env-file=.env scripts/fund-tester.ts <address>                # 0.2 SOL, 1000 mockUSDT, 20 tEQTY
node --env-file=.env scripts/fund-tester.ts <address> --sol 0.1 --usdt 500 --eqty 5
```

The demo funder needs the SOL sent plus 0.02 SOL (rent and fees): top it up from a
devnet faucet if the script says so.

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

Applied for `base-sepolia` on 2026-11-22 (chain marked reviewed by the founder): 4
listings (tEQTY, tBOND, mockUSDT, mockBRL) from ListingRegistry events in blocks
59342255 to 62135072, and the chain's settlement contract and mockUSDT set.
Robinhood and Tempo are not reviewed or synced yet.

Re-applied on 2026-11-22 after migration `20261122120000_listing_metadata`
(blocks 59342255 to 62228279) to fill `symbol` and `name` from each token's own
`symbol()` and `name()`; the Solana devnet sync was re-applied the same day from
the mints' Token-2022 metadata. Every listing publishes both:

| Chain | Listing | `symbol` | `name` |
|---|---|---|---|
| base-sepolia | `0x0f1c…bDD7` (equity) | tEQTY | Niara Demo Equity (TEST) |
| base-sepolia | `0x4b69…B5b2` (fixed income) | tBOND | Niara Demo Bond 2030 (TEST) |
| base-sepolia | `0x4ED5…7457` (currency) | mockUSDT | Niara Mock USDT (TESTNET ONLY - NO VALUE) |
| base-sepolia | `0x2624…500B` (currency) | mockBRL | Niara Mock BRL (TESTNET ONLY - NO VALUE) |
| solana-devnet | `8LjQ…zsTo` (equity) | tEQTY | Niara Demo Equity (TEST) |
| solana-devnet | `4EBR…7Jnf` (fixed income) | tDEB | Niara Demo Debenture (TEST) |
| solana-devnet | `8iWQ…A24y` (currency) | mockUSDT | Niara Mock USDT (TEST) |
| solana-devnet | `5EVn…afjk` (currency) | mockBRL | Niara Mock BRL (TEST) |

### End-to-end on Base Sepolia (`scripts/e2e-evm.ts`)

The same shape as the Solana run, with the demo investors of the niara-contracts
Base Sepolia demo: investor B (holds tEQTY) sells 10 tEQTY to investor A (holds
mockUSDT) at 25 mockUSDT; expected fee 1.25 (50 bps, rounded up), cashback 0.25
(20% of the fee), seller receives 248.75. Writes to Base Sepolia: two approvals
(one per wallet, each paying its own gas) and the worker's `settle`. Run once on
2026-11-22, every check passed: `docs/base-sepolia-e2e-2026-11-22.md`.

Before running it: apply migration `20261120130000_cancel_reasons`; mark
`base-sepolia` reviewed in `config/evm-testnets.json`; apply the listing sync for
it; set `EVM_SETTLEMENT_CHAINS=base-sepolia`, `EVM_OPERATOR_KEYSTORE`,
`EVM_OPERATOR_KEYSTORE_PASSWORD` and the two investors' keystore passwords in
`.env`; start the service.

```bash
node --env-file=.env scripts/e2e-evm.ts --dry-run   # every read-only check, nothing sent
node --env-file=.env scripts/e2e-evm.ts             # log in ~/niara-logs/
```
