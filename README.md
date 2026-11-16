# niara-exchange-engine

> **Testnet only.** No real assets, no real money, no regulatory authorization.

Off-chain side of the Niara Exchange (design spec:
`niara-exchange-solana/EXCHANGE-MULTICHAIN-DESIGN.md`, §2, §3.6, §5): wallets
sign order intents, the order service admits them and the matching engine
pairs `Equity` orders per (chain, asset), and a settlement worker (not written
yet) will settle each match on-chain through a `SettlementAdapter`. Until
then, matches are stored `pending` and **nothing is settled**.

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
| `20261116130000_fk_indexes` | **Not applied.** Indexes covering `matches (chain_id, asset)` and `settlements (match_id, chain_id)`; the founder applies it |

- The obsolete September prototype was moved to the schema
  `legacy_prototype_2026_09`, outside the API. This repo only uses `public`.
- **Never apply migrations to the remote from this repo** (no
  `supabase db push`, no migration tooling against the project, no SQL
  writes). Write the migration here, test it on PGlite, and hand it to the
  founder.

## Order service

`src/service`: one Node process with an HTTP API (Hono).

| Endpoint | Body | |
|---|---|---|
| `POST /v1/orders` | `{ intent, signature }` | Submit a signed order intent (Solana `signMessage` text or EIP-712) |
| `POST /v1/orders/cancel` | `{ cancel, signature }` | Cancel an order with a signed cancellation (by chain, wallet and nonce) |
| `GET /v1/books/:chain/:asset` | | Public book: price levels only |
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

Not tested against a real Postgres server yet (no Docker or local Supabase on
the dev machine): the tests run the service on PGlite with the real
migrations.
