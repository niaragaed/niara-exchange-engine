-- Why an order left the book, and the wallet's signature when the wallet cancelled it.
-- TESTNET ONLY.
--
-- orders.cancel_reason is set by every path that takes an order out of the book:
--   by_wallet              the wallet signed a cancellation (POST /v1/orders/cancel);
--                          orders.cancel_signature holds that signature
--   self_trade_prevention  the newest order of a wallet that would have matched its own
--   below_min_notional     the remainder (or the next match) fell below the market minimum
--   expired                no longer matchable before expires_at
--   stale                  out of the book: its on-chain delegation no longer covers it,
--                          or a failed match left it there (match_reversals)
--
-- The reason follows the status: cancelled -> one of the first three; expired -> expired;
-- stale -> stale; open, partially_filled and filled -> none. A stale order can still be
-- cancelled by its wallet, so 'stale' is the only reason that may change (to by_wallet).
--
-- cancel_signature is exactly what the wallet sent (Solana: base58 ed25519 signature of
-- the "Niara Exchange cancel order v1" text; EVM: 0x-hex EIP-712 CancelOrder signature).
-- The signed message is rebuilt from the order (chain, wallet, nonce), the chain's
-- settlement program/contract and the intent version, as for the order intent itself.
-- The cancellation is enforced off-chain only; on-chain cancel_intent belongs to the
-- on-chain signed-intents milestone.
--
-- Neither column is granted to anon/authenticated: they stay server-side.

create type public.cancel_reason as enum (
  'by_wallet', 'self_trade_prevention', 'below_min_notional', 'expired', 'stale'
);

alter table public.orders
  add column cancel_reason public.cancel_reason,
  add column cancel_signature text check (length(cancel_signature) between 1 and 200);

-- Existing rows: expired and stale carry their reason in their status. A cancelled row
-- written before this migration has no recorded reason, and there must be none.
do $$
begin
  if exists (select 1 from public.orders where status = 'cancelled') then
    raise exception 'cancel_reasons: cancelled orders exist whose reason was never recorded; resolve them first';
  end if;
end;
$$;

update public.orders set cancel_reason = status::text::public.cancel_reason
 where status in ('expired', 'stale');

alter table public.orders
  add constraint orders_cancel_reason_check check (
    case status
      when 'cancelled' then cancel_reason is not null
                        and cancel_reason in ('by_wallet', 'self_trade_prevention', 'below_min_notional')
      when 'expired' then cancel_reason is not null and cancel_reason = 'expired'
      when 'stale' then cancel_reason is not null and cancel_reason = 'stale'
      else cancel_reason is null
    end
  ),
  add constraint orders_cancel_signature_reason_check check (
    (cancel_signature is not null) = (cancel_reason is not distinct from 'by_wallet')
  );

-- The guard of 20261120120000, plus: the signature never changes once written, and a
-- recorded reason changes only from 'stale'.
create or replace function public.orders_guard_update() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if (new.id, new.seq, new.chain_id, new.asset, new.side, new.quantity, new.lot_size,
      new.limit_price, new.payment_asset, new.wallet, new.nonce, new.expires_at,
      new.intent_version, new.intent_signature, new.created_at)
     is distinct from
     (old.id, old.seq, old.chain_id, old.asset, old.side, old.quantity, old.lot_size,
      old.limit_price, old.payment_asset, old.wallet, old.nonce, old.expires_at,
      old.intent_version, old.intent_signature, old.created_at) then
    raise exception 'orders: signed intent fields are immutable' using errcode = 'check_violation';
  end if;
  if new.filled_quantity < old.filled_quantity then
    raise exception 'orders: filled_quantity cannot decrease' using errcode = 'check_violation';
  end if;
  if new.settled_quantity < old.settled_quantity
     or new.released_quantity < old.released_quantity
     or new.voided_quantity < old.voided_quantity then
    raise exception 'orders: settled, released and voided quantities cannot decrease' using errcode = 'check_violation';
  end if;
  if old.status in ('cancelled', 'expired') and new.status is distinct from old.status then
    raise exception 'orders: status % is terminal', old.status using errcode = 'check_violation';
  end if;
  if old.status = 'filled' and new.status is distinct from old.status
     and new.released_quantity = old.released_quantity and new.voided_quantity = old.voided_quantity then
    raise exception 'orders: a filled order changes status only with a release or a void'
      using errcode = 'check_violation';
  end if;
  if old.cancel_signature is not null and new.cancel_signature is distinct from old.cancel_signature then
    raise exception 'orders: cancel_signature is immutable' using errcode = 'check_violation';
  end if;
  if old.cancel_reason is not null and old.cancel_reason <> 'stale'
     and new.cancel_reason is distinct from old.cancel_reason then
    raise exception 'orders: cancel_reason % is final', old.cancel_reason using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.orders_guard_update() from public, anon, authenticated;
