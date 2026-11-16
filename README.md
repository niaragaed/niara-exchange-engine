# niara-exchange-engine

> **Testnet only.** No real assets, no real money, no regulatory authorization.

Off-chain side of the Niara Exchange (design spec:
`niara-exchange-solana/EXCHANGE-MULTICHAIN-DESIGN.md`, §2, §3.6, §5): wallets
sign order intents, the matching engine pairs `Equity` orders per
(chain, asset), and a settlement worker (not written yet) settles each match
on-chain through a `SettlementAdapter`.

Matching is off-chain and centralized by design; settlement is atomic and
on-chain. This is not a decentralized exchange.

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
```

See `CLAUDE.md` for the repo rules and `docs/decisions.md` for the design
decisions made on top of the spec.
