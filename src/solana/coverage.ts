import { PublicKey } from "@solana/web3.js";
import type { Match, Side } from "../engine/types.ts";
import { associatedTokenAddress, decodeTokenAccount, isTokenProgram, pdas } from "./accounts.ts";
import type { SolanaRpc } from "./rpc.ts";

/**
 * Delegate check (spec §3.5): an order-book order is live on-chain only while its
 * wallet's token account delegates enough to the program's vault PDA and holds enough.
 * `settle` moves both legs through the vault, so each side is checked on its own leg:
 *
 *   sell order  asset account   delegate = vault, delegated >= remaining, balance >= remaining
 *   buy order   USDT account    delegate = vault, delegated >= payment,   balance >= payment
 *               (payment = remaining / lot_size * limit_price, the most it can pay)
 *
 * The check is per order: one token account has one delegate, so several open orders
 * of one wallet on one mint need an aggregate approval, which this does not sum.
 */

export interface CoverageNeed {
  wallet: string;
  mint: string;
  amount: bigint;
}

/** For each need: null when covered, else a readable reason. Throws on RPC trouble. */
export interface CoverageChecker {
  check(needs: readonly CoverageNeed[]): Promise<(string | null)[]>;
}

export function orderNeed(o: {
  side: Side;
  wallet: string;
  asset: string;
  paymentAsset: string;
  remaining: bigint;
  lotSize: bigint;
  limitPrice: bigint;
}): CoverageNeed {
  return o.side === "sell"
    ? { wallet: o.wallet, mint: o.asset, amount: o.remaining }
    : { wallet: o.wallet, mint: o.paymentAsset, amount: (o.remaining / o.lotSize) * o.limitPrice };
}

/** What `settle` will move for a match: the seller's asset and the buyer's payment. */
export function matchNeeds(m: Match): { seller: CoverageNeed; buyer: CoverageNeed } {
  return {
    seller: { wallet: m.seller, mint: m.asset, amount: m.quantity },
    buyer: { wallet: m.buyer, mint: m.paymentAsset, amount: m.paymentAmount },
  };
}

export function solanaCoverageChecker(rpc: SolanaRpc, programId: PublicKey): CoverageChecker {
  const vault = pdas(programId).vaultAuthority();
  return {
    async check(needs) {
      if (needs.length === 0) return [];
      const mints = [...new Set(needs.map((n) => n.mint))];
      const mintAccounts = await rpc.getAccounts(mints.map((m) => new PublicKey(m)));
      const tokenProgram = new Map(mints.map((m, i) => [m, mintAccounts[i]?.owner]));
      const addresses = needs.map((n) => {
        const program = tokenProgram.get(n.mint);
        return program && isTokenProgram(program)
          ? associatedTokenAddress(new PublicKey(n.mint), new PublicKey(n.wallet), program)
          : null;
      });
      const accounts = await rpc.getAccounts(addresses.filter((a): a is PublicKey => a !== null));
      let next = 0;
      return needs.map((n, i) => {
        if (addresses[i] === null) return `mint ${n.mint} not found`;
        const account = accounts[next++];
        if (!account) return "the wallet has no token account for this mint";
        const t = decodeTokenAccount(account.data);
        if (t.state !== 1) return "the token account is frozen or not initialized";
        if (!t.delegate || !t.delegate.equals(vault)) return "the token account does not delegate to the vault";
        if (t.delegatedAmount < n.amount) return `delegated ${t.delegatedAmount} < needed ${n.amount}`;
        if (t.amount < n.amount) return `balance ${t.amount} < needed ${n.amount}`;
        return null;
      });
    },
  };
}
