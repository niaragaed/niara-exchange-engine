-- Niara Exchange: iceberg orders (order intent v3). TESTNET ONLY.
--
-- An iceberg order signs a display quantity (src/intents, intent v3): only a slice of
-- min(display_quantity, remaining) rests in the book at a time. When a slice is used up,
-- a new slice is shown at the same price with a new time priority (behind every order
-- already resting). The rest is hidden: no public read may show it.
--
--   display_quantity  signed, immutable; null = shown whole (every v1 and v2 order)
--   visible_quantity  icebergs: the current slice (written by the service); null otherwise
--   priority_seq      icebergs: the time priority of the current slice once refreshed,
--                     taken from the same sequence as orders.seq; null = seq
--   book_quantity     generated: what the public book shows of the order (the visible
--                     slice of an iceberg, the remaining quantity of any other order)
--
-- Privacy: anon/authenticated could read orders.quantity and the fill counters of live
-- orders (column grants of 20261116120000 and 20261120120000), which would show an
-- iceberg's hidden quantity. Those grants are replaced by book_quantity, and order_book
-- sums it: same columns as before, visible slices only. display_quantity,
-- visible_quantity and priority_seq are not granted.
--
-- Honest limit: the on-chain approval (SPL delegation, ERC-20 allowance) that covers an
-- order is public, so anyone can read up to the total an iceberg may trade. Iceberg
-- hides size from the book, not from the chain.
--
-- Backward compatible: existing rows and inserts that omit the new columns are orders
-- shown whole, and book_quantity is computed for them, so the service built before this
-- migration keeps working once it is applied. The service built after it refuses to
-- start until it is applied (REQUIRED_MIGRATIONS).
--
-- Safe in one transaction.

alter table public.orders
  add column display_quantity public.base_units,
  add column visible_quantity public.base_units,
  add column priority_seq bigint;

alter table public.orders
  add column book_quantity numeric generated always as (
    coalesce(visible_quantity, quantity - (filled_quantity - released_quantity - voided_quantity))
  ) stored;

comment on column public.orders.display_quantity is
  'Iceberg (intent v3, signed): asset base units shown in the book at a time; whole lots, at least one lot, less than quantity; GTC only. Null: shown whole.';
comment on column public.orders.visible_quantity is
  'Iceberg: the current visible slice (at most display_quantity and the remaining quantity while it rests). Null for an order shown whole.';
comment on column public.orders.priority_seq is
  'Iceberg: time priority of the current slice after a refresh (a later value of the order sequence). Null: seq.';
comment on column public.orders.book_quantity is
  'What the public book shows of the order: the visible slice of an iceberg, the remaining quantity otherwise.';

alter table public.orders
  -- Only v3 intents sign a display quantity, only GTC orders rest, and a slice is whole
  -- lots, at least one lot, below the quantity.
  add constraint orders_display_quantity_check check (
    display_quantity is null or (
      intent_version >= 3
      and time_in_force = 'gtc'
      and display_quantity >= 1
      and display_quantity < quantity
      and mod(display_quantity, lot_size) = 0
    )
  ),
  -- A v3 intent is an iceberg.
  add constraint orders_v3_iceberg_check check (intent_version <> 3 or display_quantity is not null),
  -- The slice exists exactly for icebergs, never above the display quantity, and while
  -- the order rests it is a positive part of its remaining quantity.
  add constraint orders_visible_quantity_check check (
    case
      when display_quantity is null then visible_quantity is null
      else visible_quantity is not null
       and visible_quantity <= display_quantity
       and (status not in ('open', 'partially_filled')
            or (visible_quantity > 0
                and visible_quantity <= quantity - (filled_quantity - released_quantity - voided_quantity)))
    end
  ),
  -- Only an iceberg's slice gets a new priority, always later than its arrival.
  add constraint orders_priority_seq_check check (
    priority_seq is null or (display_quantity is not null and priority_seq > seq)
  );

-- Two slices never share a priority.
create unique index orders_priority_seq_key on public.orders (priority_seq) where priority_seq is not null;

-- The guard of 20261124120000, with display_quantity among the immutable signed fields,
-- and a slice's priority that only moves later.
create or replace function public.orders_guard_update() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if (new.id, new.seq, new.chain_id, new.asset, new.side, new.quantity, new.lot_size,
      new.limit_price, new.payment_asset, new.wallet, new.nonce, new.expires_at,
      new.intent_version, new.intent_signature, new.time_in_force, new.display_quantity, new.created_at)
     is distinct from
     (old.id, old.seq, old.chain_id, old.asset, old.side, old.quantity, old.lot_size,
      old.limit_price, old.payment_asset, old.wallet, old.nonce, old.expires_at,
      old.intent_version, old.intent_signature, old.time_in_force, old.display_quantity, old.created_at) then
    raise exception 'orders: signed intent fields are immutable' using errcode = 'check_violation';
  end if;
  if old.priority_seq is not null
     and (new.priority_seq is null or new.priority_seq < old.priority_seq) then
    raise exception 'orders: priority_seq only moves later' using errcode = 'check_violation';
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

-- Public reads: the quantity and the fill counters would show an iceberg's hidden
-- quantity, so clients read book_quantity instead.
revoke select (quantity, filled_quantity, released_quantity, voided_quantity)
  on public.orders from anon, authenticated;
grant select (book_quantity) on public.orders to anon, authenticated;

-- Same columns as before; an iceberg counts for its visible slice only.
create or replace view public.order_book with (security_invoker = true) as
  select
    chain_id,
    asset,
    side,
    limit_price as price,
    lot_size,
    sum(book_quantity)::public.base_units as quantity,
    count(*) as orders
  from public.orders
  where status in ('open', 'partially_filled') and expires_at > now()
  group by chain_id, asset, side, limit_price, lot_size;
