# CLAUDE.md — niara-exchange-engine

Off-chain side of the Niara Exchange: signed order intents, the matching engine,
the Supabase schema and (later) the settlement worker. **Testnet only**: no real
assets, no real money, no regulatory authorization.

## Source of truth

The design spec is `~/niara-exchange-solana/EXCHANGE-MULTICHAIN-DESIGN.md`
(sections 2, 3.6, 5, 7 and 9.12 matter most here). It belongs to the
`niara-exchange-solana` repo: **never edit it from here**. When this repo needs
the spec to change, propose the edit under "Spec edits needed" in the report.

Related repos, read only from here:
- `~/niara-exchange-solana`: Anchor program `niara_exchange` (`settle`, §3.4).
- `/mnt/c/Users/henri/niara-contracts`: EVM contracts (`NiaraSettlement.settle`).

## Layout

| Path | What |
|---|---|
| `src/chains.ts` | The five v1 chains and their CAIP-2 ids |
| `src/engine/` | Matching engine: pure, deterministic, in memory (no I/O, no clock, no randomness: time and ids are passed in) |
| `src/intents/` | Order intent format (Solana `signMessage`, EVM EIP-712), verification, admission |
| `src/adapters/` | `SettlementAdapter` interface (spec §2) only |
| `src/worker/` | Settlement worker: a stub that refuses to run |
| `supabase/migrations/` | Postgres 17 schema. Written here, applied only on an explicit request |
| `test/` | vitest unit tests and fast-check property tests |

## Commands

```bash
npm ci --ignore-scripts      # once per clone (heavy: run alone)
npm run typecheck
npm test                     # vitest, one worker
```

Keep logs under `~/niara-logs/`, not `/tmp`.

## Rules

- **English** for code, comments, docs and commit messages.
- **No AI attribution** in commits or PR descriptions: no `Co-Authored-By`
  trailer, no "Generated with" line.
- **One commit per requested step**, conventional prefixes (`feat(engine):`,
  `feat(db):`, `test:`, `docs:`, `chore:`). **Never push.**
- **Never commit `.env` files, keys or keypairs** (`*-keypair.json`, `id.json`,
  operator keys, RPC URLs with API keys). Review `git status` before every
  commit. **No secrets in `NEXT_PUBLIC_*`** variables: operator keys and the
  Supabase service role key live only in the server environment.
- **Never use `git reset`, `git checkout`, `git restore`, `git stash` or
  `git clean` on uncommitted work.** The only way to unstage is
  `git restore --staged <path>`, which leaves the working tree alone.
- **Nothing simulated may look real.** A stub says it is a stub; mock tokens,
  test data and demo values are labeled as such; nothing claims a settlement,
  a deployment or a listing that did not happen on-chain.
- Quantities and prices are integers in base units (`bigint` in TypeScript,
  `numeric(78,0)` in Postgres), never floats.
- No network writes and no chain access without an explicit request in the
  current conversation (no migration applied, no deploy, no transaction).

## Machine limits

The dev machine has 8 GB RAM (WSL gets about 4.8 GB); going over it kills the
WSL session.

- **No Docker and no local Supabase stack** (`supabase start` is forbidden).
- **One heavy process at a time**: `npm install`/`npm ci`, the typecheck and
  the test run never run concurrently, and never in the background.
- Check `ps` for leftover validators or node processes before a heavy command.
- vitest runs one worker (`vitest.config.ts`); do not raise it.
