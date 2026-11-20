import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, isAddress, type Address } from "viem";
import { CHAINS, type ChainId } from "../chains.ts";

/**
 * Per-chain settings of the EVM testnets (`config/evm-testnets.json`): contract
 * addresses, the settlement operator, the block the deployment started at, gas rules and
 * the reviewed lot sizes. TESTNET ONLY. Public values only: no keys, no RPC URLs.
 *
 * Every address is checked on-chain before use (the adapter and the sync compare the
 * contracts' own links and roles with these values), so a wrong entry stops the run
 * instead of sending to the wrong place.
 */

export const EVM_CHAIN_IDS = ["base-sepolia", "robinhood-testnet", "tempo-testnet", "hyperevm-testnet"] as const;
export type EvmChainId = (typeof EVM_CHAIN_IDS)[number];

export const DEFAULT_EVM_CONFIG = join(import.meta.dirname, "..", "..", "config", "evm-testnets.json");

/**
 * - `eip1559`: type-2 transactions, fees from the node (Base Sepolia, Robinhood).
 * - `tempo`: Tempo transactions (type 0x76) paying the fee in `feeToken` (pathUSD); gas is
 *   priced in attodollars, there is no native gas token.
 * - `legacy`: type-0 transactions with `gasPrice` (HyperEVM).
 */
export type GasPricing = "eip1559" | "tempo" | "legacy";

export interface GasRules {
  pricing: GasPricing;
  /** Gas limit = the node's estimate x multiplierPct / 100 (forge's --gas-estimate-multiplier). */
  multiplierPct: number;
  /** A settlement needing more is refused before sending (block or small-block cap). */
  maxGasPerTx: bigint | null;
  /** Tempo: the token fees are paid in. */
  feeToken: Address | null;
}

export interface EvmContracts {
  listingRegistry: Address;
  settlement: Address;
  cashbackDistributor: Address;
}

export interface EvmChainSettings {
  chain: EvmChainId;
  evmChainId: number;
  deployed: boolean;
  /** Settlement and `--apply` are refused on a chain until a person has reviewed it. */
  reviewed: boolean;
  contracts: EvmContracts | null;
  /** mock USDT: `NiaraSettlement.feeToken`, the only payment token. */
  quoteAsset: Address | null;
  /** The expected holder of SETTLEMENT_OPERATOR_ROLE. */
  operator: Address | null;
  /** First block of the deployment: event scans start here. */
  fromBlock: bigint | null;
  gas: GasRules;
  explorer: string | null;
  lotSizes: Record<Address, { symbol: string; lotSize: bigint }>;
}

/** A deployed chain: every address is set. */
export type DeployedEvmChain = EvmChainSettings & {
  contracts: EvmContracts;
  quoteAsset: Address;
  operator: Address;
  fromBlock: bigint;
};

export class EvmSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvmSettingsError";
  }
}

export function isEvmChainId(value: unknown): value is EvmChainId {
  return typeof value === "string" && (EVM_CHAIN_IDS as readonly string[]).includes(value);
}

function address(where: string, v: unknown): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new EvmSettingsError(`${where} must be an address`);
  return getAddress(v);
}

function optional<T>(v: unknown, parse: (v: unknown) => T): T | null {
  return v === null || v === undefined ? null : parse(v);
}

function positiveInt(where: string, v: unknown): bigint {
  if (typeof v !== "string" || !/^[1-9][0-9]*$/.test(v)) throw new EvmSettingsError(`${where} must be a positive integer string`);
  return BigInt(v);
}

function parseChain(chain: EvmChainId, o: Record<string, unknown>): EvmChainSettings {
  const at = (k: string) => `${chain}.${k}`;
  if (o["evmChainId"] !== CHAINS[chain as ChainId].evmChainId) {
    throw new EvmSettingsError(`${at("evmChainId")} must be ${CHAINS[chain as ChainId].evmChainId}`);
  }
  for (const k of ["deployed", "reviewed"]) {
    if (typeof o[k] !== "boolean") throw new EvmSettingsError(`${at(k)} must be true or false`);
  }
  const c = o["contracts"] as Record<string, unknown> | null;
  const contracts = optional(c, () => ({
    listingRegistry: address(at("contracts.listingRegistry"), c!["listingRegistry"]),
    settlement: address(at("contracts.settlement"), c!["settlement"]),
    cashbackDistributor: address(at("contracts.cashbackDistributor"), c!["cashbackDistributor"]),
  }));
  const g = o["gas"] as Record<string, unknown>;
  if (typeof g !== "object" || g === null) throw new EvmSettingsError(`${at("gas")} must be an object`);
  if (g["pricing"] !== "eip1559" && g["pricing"] !== "tempo" && g["pricing"] !== "legacy") {
    throw new EvmSettingsError(`${at("gas.pricing")} must be eip1559, tempo or legacy`);
  }
  const multiplierPct = g["multiplierPct"];
  if (typeof multiplierPct !== "number" || !Number.isInteger(multiplierPct) || multiplierPct < 100 || multiplierPct > 1000) {
    throw new EvmSettingsError(`${at("gas.multiplierPct")} must be a whole number from 100 to 1000`);
  }
  const feeToken = optional(g["feeToken"], (v) => address(at("gas.feeToken"), v));
  if ((g["pricing"] === "tempo") !== (feeToken !== null)) {
    throw new EvmSettingsError(`${at("gas.feeToken")} is required with tempo pricing, and only then`);
  }
  const lots = o["lotSizes"] as Record<string, { symbol?: unknown; lotSize?: unknown }>;
  if (typeof lots !== "object" || lots === null) throw new EvmSettingsError(`${at("lotSizes")} must be an object`);
  const lotSizes: EvmChainSettings["lotSizes"] = {};
  for (const [token, v] of Object.entries(lots)) {
    lotSizes[address(at(`lotSizes.${token}`), token)] = {
      symbol: String(v.symbol ?? ""),
      lotSize: positiveInt(at(`lotSizes.${token}.lotSize`), v.lotSize),
    };
  }
  const settings: EvmChainSettings = {
    chain,
    evmChainId: o["evmChainId"] as number,
    deployed: o["deployed"] as boolean,
    reviewed: o["reviewed"] as boolean,
    contracts,
    quoteAsset: optional(o["quoteAsset"], (v) => address(at("quoteAsset"), v)),
    operator: optional(o["operator"], (v) => address(at("operator"), v)),
    fromBlock: optional(o["fromBlock"], (v) => positiveInt(at("fromBlock"), v)),
    gas: {
      pricing: g["pricing"],
      multiplierPct,
      maxGasPerTx: optional(g["maxGasPerTx"], (v) => positiveInt(at("gas.maxGasPerTx"), v)),
      feeToken,
    },
    explorer: optional(o["explorer"], (v) => {
      if (typeof v !== "string" || !v.startsWith("https://")) throw new EvmSettingsError(`${at("explorer")} must be an https URL`);
      return v.replace(/\/$/, "");
    }),
    lotSizes,
  };
  if (settings.deployed && (!settings.contracts || !settings.quoteAsset || !settings.operator || settings.fromBlock === null)) {
    throw new EvmSettingsError(`${chain} is deployed but its contracts, quoteAsset, operator or fromBlock is missing`);
  }
  return settings;
}

export function parseEvmSettings(json: unknown): Record<EvmChainId, EvmChainSettings> {
  const chains = (json as { chains?: unknown })?.chains as Record<string, unknown> | undefined;
  if (typeof chains !== "object" || chains === null) throw new EvmSettingsError("config.chains must be an object");
  for (const k of Object.keys(chains)) if (!isEvmChainId(k)) throw new EvmSettingsError(`config.chains: unknown chain ${k}`);
  const out = {} as Record<EvmChainId, EvmChainSettings>;
  for (const id of EVM_CHAIN_IDS) {
    const o = chains[id];
    if (typeof o !== "object" || o === null) throw new EvmSettingsError(`config.chains.${id} is missing`);
    out[id] = parseChain(id, o as Record<string, unknown>);
  }
  return out;
}

export function loadEvmSettings(path: string = DEFAULT_EVM_CONFIG): Record<EvmChainId, EvmChainSettings> {
  return parseEvmSettings(JSON.parse(readFileSync(path, "utf8")));
}

/** The chain's settings, refused unless it is deployed (and reviewed, when `reviewed` is asked). */
export function deployedChain(
  all: Record<EvmChainId, EvmChainSettings>,
  chain: EvmChainId,
  opts: { requireReviewed: boolean },
): DeployedEvmChain {
  const s = all[chain];
  if (!s.deployed) throw new EvmSettingsError(`${chain} has no deployment (config: deployed false)`);
  if (opts.requireReviewed && !s.reviewed) {
    throw new EvmSettingsError(`${chain} is not marked reviewed in the config file: refusing`);
  }
  return s as DeployedEvmChain;
}

export function explorerTx(s: EvmChainSettings, hash: string): string | null {
  return s.explorer ? `${s.explorer}/tx/${hash}` : null;
}
