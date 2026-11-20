import type { Address, Log } from "viem";
import type { EvmClient } from "./client.ts";

/**
 * Chunked `eth_getLogs` over a block range. Public testnet RPCs cap the range of one
 * query (and some answer "too many results"): a refused chunk is halved and retried,
 * down to `minChunk`. Read-only.
 */

export interface ScanOptions {
  address: Address;
  /** Event topic0 values to match (any of them). */
  topics: readonly `0x${string}`[];
  /** Extra indexed topics (topic1..3), null = any. */
  indexed?: readonly (`0x${string}` | null)[];
  fromBlock: bigint;
  toBlock: bigint;
  chunk?: bigint;
  minChunk?: bigint;
}

const RANGE_REFUSED = /range|too many|limit|exceed|10000|block range|query returned more/i;

async function getLogs(client: EvmClient, o: ScanOptions, from: bigint, to: bigint): Promise<Log[]> {
  return (await client.request({
    method: "eth_getLogs",
    params: [
      {
        address: o.address,
        topics: [[...o.topics], ...(o.indexed ?? [])],
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
      },
    ],
  } as never)) as Log[];
}

/** Every matching log from `fromBlock` to `toBlock`, oldest first. */
export async function scanLogs(client: EvmClient, o: ScanOptions): Promise<Log[]> {
  let chunk = o.chunk ?? 10_000n;
  const min = o.minChunk ?? 100n;
  const out: Log[] = [];
  for (let from = o.fromBlock; from <= o.toBlock; ) {
    const to = from + chunk - 1n < o.toBlock ? from + chunk - 1n : o.toBlock;
    try {
      out.push(...(await getLogs(client, o, from, to)));
      from = to + 1n;
    } catch (e) {
      if (chunk > min && RANGE_REFUSED.test(e instanceof Error ? e.message : String(e))) {
        chunk = chunk / 2n > min ? chunk / 2n : min;
        continue;
      }
      throw e;
    }
  }
  return out;
}

/** The newest matching log that satisfies `accept`, scanning back from `toBlock`; null if none. */
export async function findLogBackward(
  client: EvmClient,
  o: ScanOptions,
  accept: (log: Log) => boolean,
): Promise<Log | null> {
  let chunk = o.chunk ?? 10_000n;
  const min = o.minChunk ?? 100n;
  for (let to = o.toBlock; to >= o.fromBlock; ) {
    const from = to - chunk + 1n > o.fromBlock ? to - chunk + 1n : o.fromBlock;
    let logs: Log[];
    try {
      logs = await getLogs(client, o, from, to);
    } catch (e) {
      if (chunk > min && RANGE_REFUSED.test(e instanceof Error ? e.message : String(e))) {
        chunk = chunk / 2n > min ? chunk / 2n : min;
        continue;
      }
      throw e;
    }
    for (let i = logs.length - 1; i >= 0; i--) if (accept(logs[i]!)) return logs[i]!;
    to = from - 1n;
  }
  return null;
}
