import { createPublicClient, http, type Chain, type PublicClient, type Transport } from "viem";
import { baseSepolia, hyperliquidEvmTestnet, robinhoodTestnet, tempoModerato } from "viem/chains";
import { CHAINS } from "../chains.ts";
import type { EvmChainId } from "./settings.ts";

/**
 * EVM TESTNET RPC clients. Every entry point checks the node's `eth_chainId` against the
 * chain it expects, so a misconfigured URL can never reach a mainnet or another chain.
 */

export const VIEM_CHAINS: Record<EvmChainId, Chain> = {
  "base-sepolia": baseSepolia,
  "robinhood-testnet": robinhoodTestnet,
  "tempo-testnet": tempoModerato,
  "hyperevm-testnet": hyperliquidEvmTestnet,
};

/** Same variable names as niara-contracts' `.env`. A private URL may carry an API key. */
export const RPC_ENV: Record<EvmChainId, string> = {
  "base-sepolia": "BASE_SEPOLIA_RPC_URL",
  "robinhood-testnet": "ROBINHOOD_TESTNET_RPC_URL",
  "tempo-testnet": "TEMPO_TESTNET_RPC_URL",
  "hyperevm-testnet": "HYPEREVM_TESTNET_RPC_URL",
};

/** Public RPCs (niara-contracts README, "Testnet deployment"). */
export const PUBLIC_RPC: Record<EvmChainId, string> = {
  "base-sepolia": "https://sepolia.base.org",
  "robinhood-testnet": "https://rpc.testnet.chain.robinhood.com",
  "tempo-testnet": "https://rpc.moderato.tempo.xyz",
  "hyperevm-testnet": "https://rpc.hyperliquid-testnet.xyz/evm",
};

export type EvmClient = PublicClient<Transport, Chain>;

export class WrongChainError extends Error {
  constructor(chain: EvmChainId, got: number) {
    super(`the RPC for ${chain} answers chain id ${got}, not ${CHAINS[chain].evmChainId}: refusing`);
    this.name = "WrongChainError";
  }
}

export function rpcUrlFor(chain: EvmChainId, env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env[RPC_ENV[chain]] || PUBLIC_RPC[chain];
}

/** A client for `chain`, after checking the node's chain id. No retries inside viem: the worker retries. */
export async function connectEvm(chain: EvmChainId, transport: Transport): Promise<EvmClient> {
  const client = createPublicClient({ chain: VIEM_CHAINS[chain], transport }) as EvmClient;
  const id = await client.getChainId();
  if (id !== CHAINS[chain].evmChainId) throw new WrongChainError(chain, id);
  return client;
}

export function httpTransport(url: string): Transport {
  return http(url, { retryCount: 0, timeout: 20_000 });
}
