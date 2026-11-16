/**
 * The five v1 chains (spec §2 `SettlementAdapter.chain`, §4.3, §9.9). Testnets only.
 * Ethereum Sepolia is deferred from v1 (§9.9) and is not listed.
 *
 * `caip2` is the CAIP-2 chain id that order intents sign (src/intents): `eip155:<chainId>`
 * for EVM, `solana:<first 32 chars of the genesis hash>` for Solana.
 */
export const CHAIN_IDS = [
  "solana-devnet",
  "base-sepolia",
  "robinhood-testnet",
  "hyperevm-testnet",
  "tempo-testnet",
] as const;

export type ChainId = (typeof CHAIN_IDS)[number];

export type ChainKind = "solana" | "evm";

export interface ChainInfo {
  id: ChainId;
  kind: ChainKind;
  caip2: string;
  /** EIP-155 chain id; null on Solana. */
  evmChainId: number | null;
  /** Full genesis hash; null on EVM. */
  solanaGenesisHash: string | null;
}

/** Devnet genesis hash, as checked by the Solana repo's `scripts/common.ts`. */
export const SOLANA_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export const CHAINS: Readonly<Record<ChainId, ChainInfo>> = {
  "solana-devnet": {
    id: "solana-devnet",
    kind: "solana",
    caip2: `solana:${SOLANA_DEVNET_GENESIS.slice(0, 32)}`,
    evmChainId: null,
    solanaGenesisHash: SOLANA_DEVNET_GENESIS,
  },
  "base-sepolia": { id: "base-sepolia", kind: "evm", caip2: "eip155:84532", evmChainId: 84532, solanaGenesisHash: null },
  "robinhood-testnet": {
    id: "robinhood-testnet",
    kind: "evm",
    caip2: "eip155:46630",
    evmChainId: 46630,
    solanaGenesisHash: null,
  },
  "hyperevm-testnet": { id: "hyperevm-testnet", kind: "evm", caip2: "eip155:998", evmChainId: 998, solanaGenesisHash: null },
  "tempo-testnet": { id: "tempo-testnet", kind: "evm", caip2: "eip155:42431", evmChainId: 42431, solanaGenesisHash: null },
};

export function isChainId(value: unknown): value is ChainId {
  return typeof value === "string" && (CHAIN_IDS as readonly string[]).includes(value);
}
