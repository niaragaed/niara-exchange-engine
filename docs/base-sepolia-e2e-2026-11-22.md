# Base Sepolia end-to-end, 2026-11-22

> TESTNET ONLY: Base Sepolia (chain id 84532), test tokens (tEQTY, mockUSDT).
> No real assets, no real money. Public addresses and transaction hashes only.

Run once, on the founder's go-ahead. Full logs (not in git):
`~/niara-logs/sync-evm-base-sepolia-20261122T115801Z.log`,
`~/niara-logs/service-e2e-evm-20261122T141449Z.log`,
`~/niara-logs/e2e-evm-2026-11-22T14-16-35-977Z.log` (dry run),
`~/niara-logs/e2e-evm-2026-11-22T14-17-46-251Z.log` (run).

1. `scripts/sync-evm-listings.ts --chain base-sepolia --apply` (config reviewed
   by the founder): ListingRegistry events from block 59342255 to 62135072;
   4 approved listings upserted (tEQTY, tBOND, mockUSDT, mockBRL);
   `chains.base-sepolia` set to settlement `0x14C6F9DeD6C97F67149B4305c57331F9d3820B6F`
   (NiaraSettlement) and quote asset `0x4ED579b02B53d050624c0F04Fb1F4D9b1d347457`
   (mockUSDT, `NiaraSettlement.feeToken`), written at 12:56:09Z.
2. Order service and worker started (`npm start`, `EVM_SETTLEMENT_CHAINS=base-sepolia`),
   single instance; the base-sepolia worker's operator is
   `0x59ff48062E4BfAb0F0DD94377b0C6f8203f078f3`.
3. `scripts/e2e-evm.ts --dry-run`: every check passed, nothing sent.
4. `scripts/e2e-evm.ts`: 10 tEQTY at 25 mockUSDT.

| Step | Base Sepolia transaction | Block | Gas used |
|---|---|---|---|
| Seller (investor B) approves exactly 10 tEQTY to NiaraSettlement | [`0x1ce44def…494668`](https://sepolia.basescan.org/tx/0x1ce44def8d0a47132cf3ec44682cf25301b49457e9b0fa7c25d8d04dff494668) | 62176012 | 46,412 |
| Buyer (investor A) approves exactly 250 mockUSDT to NiaraSettlement | [`0xda32312c…c21f0a`](https://sepolia.basescan.org/tx/0xda32312cd2a1e6bbaf301bb70f2cdaece4be5c794d3d0821e5fbfcd83cc21f0a) | 62176018 | 46,343 |
| `settle`, by the worker (attempt 1) | [`0x1afcbb05…00b85d`](https://sepolia.basescan.org/tx/0x1afcbb05c0317704200ea6ee1a114ad6c59f636137ceee24382eef4cb700b85d) | 62176172 | 175,016 |

All three are type-2 (EIP-1559) transactions with status success.

Match `ee361b38-fd93-4c24-b1e0-79b399f31b7d` (sell order `49e6496b-…`, buy
order `7efa8526-…`): settled after 1 attempt, `alreadySettled` false.

`Settled` event (NiaraSettlement): matchId `0xee361b38fd934c24b1e079b399f31b7d`
(the match UUID's 16 bytes), assetAmount 10 tEQTY, paymentAmount 250 mockUSDT,
**feeCharged 1.25**. `FeeRecorded` event (CashbackDistributor): fee 1.25,
**cashback 0.25** (to the tEQTY issuer), eligible true. The seller received
**248.75**.

| | Before | After |
|---|---|---|
| Seller `0xEda1A2ED4B76c8F0EE471B4DB750CAdBf6Fd9E06` (demo investor B) | 900 tEQTY, 9,950.00 mockUSDT | 890 tEQTY, 10,198.75 mockUSDT |
| Buyer `0x20fFBc64D8b8941003e0B10e07a4e0BfAcEcAE85` (demo investor A) | 100 tEQTY, 5,970.00 mockUSDT | 110 tEQTY, 5,720.00 mockUSDT |
| CashbackDistributor `0x4b10fF1a44Aca4118F75b1f326cC2EE46b73ADD4` | 2,065.00 mockUSDT | 2,066.25 mockUSDT |

All eight checks of the script passed. The service was then stopped
(SIGTERM); no process was left running and port 8787 was free.
