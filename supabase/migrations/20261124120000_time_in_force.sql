-- Niara Exchange: time in force (order intent v2) and the ioc_unfilled cancel reason.
-- TESTNET ONLY.
--
-- Order intent v2 signs a time in force (src/intents):
--   gtc  good till cancelled: the unmatched remainder rests in the book (every v1 order)
--   ioc  immediate or cancel: matched at once up to the signed limit price; the unmatched
--        remainder is cancelled with cancel_reason 'ioc_unfilled' and never rests. A
--        market order is an IOC whose limit price is a price cap (docs/decisions.md).
--
-- Backward compatible: existing rows and inserts that omit the column are 'gtc', so the
-- service built before this migration keeps working once it is applied. The service
-- built after it refuses to start until it is applied (REQUIRED_MIGRATIONS).
--
-- Safe in one transaction: the new enum value 'ioc_unfilled' is only compared as text
-- below (Postgres refuses to use a value added in the same transaction as a constant).
--
-- Not granted to anon/authenticated: the public book only shows resting orders, and an
-- IOC never rests.

alter type public.cancel_reason add value if not exists 'ioc_unfilled';

create type public.time_in_force as enum ('gtc', 'ioc');

alter table public.orders
  add column time_in_force public.time_in_force not null default 'gtc';

comment on column public.orders.time_in_force is
  'Signed with the intent (v2). gtc: the remainder rests; ioc: the remainder is cancelled (ioc_unfilled). v1 intents are gtc.';

alter table public.orders
  -- v1 intents did not sign a time in force: they are GTC.
  add constraint orders_time_in_force_version_check
    check (intent_version >= 2 or time_in_force = 'gtc'),
  -- An IOC never rests in the book.
  add constraint orders_ioc_never_rests_check
    check (time_in_force = 'gtc' or status not in ('open', 'partially_filled')),
  -- ioc_unfilled is the reason of IOC orders only.
  add constraint orders_ioc_unfilled_check
    check (cancel_reason is null or cancel_reason::text <> 'ioc_unfilled' or time_in_force = 'ioc');

-- The reason follows the status (20261120130000), with ioc_unfilled among the reasons of
-- a cancelled order.
alter table public.orders drop constraint orders_cancel_reason_check;
alter table public.orders
  add constraint orders_cancel_reason_check check (
    case status
      when 'cancelled' then cancel_reason is not null
                        and cancel_reason::text in ('by_wallet', 'self_trade_prevention', 'below_min_notional', 'ioc_unfilled')
      when 'expired' then cancel_reason is not null and cancel_reason::text = 'expired'
      when 'stale' then cancel_reason is not null and cancel_reason::text = 'stale'
      else cancel_reason is null
    end
  );

-- The guard of 20261120130000, with time_in_force among the immutable signed fields.
create or replace function public.orders_guard_update() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if (new.id, new.seq, new.chain_id, new.asset, new.side, new.quantity, new.lot_size,
      new.limit_price, new.payment_asset, new.wallet, new.nonce, new.expires_at,
      new.intent_version, new.intent_signature, new.time_in_force, new.created_at)
     is distinct from
     (old.id, old.seq, old.chain_id, old.asset, old.side, old.quantity, old.lot_size,
      old.limit_price, old.payment_asset, old.wallet, old.nonce, old.expires_at,
      old.intent_version, old.intent_signature, old.time_in_force, old.created_at) then
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
