-- Failed matches after both orders were filled ("busted trades").
-- TESTNET ONLY: no real assets, no real money. Written in niara-exchange-engine,
-- applied by the founder (never from the repo).
--
-- Before: a match fills both orders at matching time. If the match then fails
-- (a delegation was revoked, the chain refused it, it expired), filled_quantity
-- cannot decrease, so the innocent side's quantity was lost to it.
--
-- After: every quantity an order gives up is a monotonic counter backed by rows:
--
--   filled_quantity    total ever matched (unchanged meaning, never decreases)
--   settled_quantity   matched and settled on-chain (= its settled matches)
--   released_quantity  of failed matches, returned to this order (it was not at fault)
--   voided_quantity    of failed matches, lost by this order (it defaulted)
--
--   net matched = filled - released - voided      remaining = quantity - net
--   in flight   = filled - settled - released - voided
--
-- match_reversals holds one row per (failed match, order): released or voided,
-- with the fault and the reason. Deferred constraint triggers check, at commit,
-- that each counter equals the sum of its rows and that every failed match has
-- exactly one row per order. Status follows net matched; 'filled' is no longer
-- terminal, but may only go back in the same update that releases or voids.

-- ---------------------------------------------------------------------------
-- Columns and types
-- ---------------------------------------------------------------------------

alter table public.orders
  add column settled_quantity public.base_units not null default 0,
  add column released_quantity public.base_units not null default 0,
  add column voided_quantity public.base_units not null default 0;

-- seller / buyer  that side's delegation or balance no longer covered the match
-- both            both sides'
-- expired         the match could not settle before its expires_at
-- none            the chain refused it for another reason, or retries ran out
create type public.match_fault as enum ('seller', 'buyer', 'both', 'expired', 'none');
create type public.reversal_kind as enum ('released', 'voided');

create table public.match_reversals (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id),
  order_id uuid not null references public.orders (id),
  kind public.reversal_kind not null,
  fault public.match_fault not null,
  quantity public.base_units not null check (quantity > 0),
  reason text not null check (length(reason) between 1 and 1000),
  created_at timestamptz not null default now(),
  unique (match_id, order_id)
);

create index match_reversals_order_idx on public.match_reversals (order_id);

-- ---------------------------------------------------------------------------
-- Order checks: replace the filled-only checks with net-matched ones
-- ---------------------------------------------------------------------------

do $$
declare
  c record;
begin
  -- The unnamed table checks of 20261116120000 that read filled_quantity.
  for c in
    select conname from pg_constraint
     where conrelid = 'public.orders'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%filled_quantity%'
  loop
    execute format('alter table public.orders drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table public.orders
  add constraint orders_quantities_check check (
    filled_quantity % lot_size = 0
    and settled_quantity % lot_size = 0
    and released_quantity % lot_size = 0
    and voided_quantity % lot_size = 0
    and settled_quantity + released_quantity + voided_quantity <= filled_quantity
    and filled_quantity - released_quantity - voided_quantity <= quantity
  ),
  add constraint orders_status_check check (
    case status
      when 'open' then filled_quantity - released_quantity - voided_quantity = 0
      when 'partially_filled' then filled_quantity - released_quantity - voided_quantity > 0
                              and filled_quantity - released_quantity - voided_quantity < quantity
      when 'filled' then filled_quantity - released_quantity - voided_quantity = quantity
      else filled_quantity - released_quantity - voided_quantity < quantity
    end
  );

-- Signed fields immutable; every counter monotonic; cancelled/expired terminal;
-- 'filled' leaves only together with a release or a void.
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
  return new;
end;
$$;

-- Existing settled matches: their quantity is settled on both orders.
update public.orders o
   set settled_quantity = s.quantity
  from (
    select x.order_id, sum(x.quantity) as quantity
      from (
        select buy_order as order_id, quantity from public.matches where status = 'settled'
        union all
        select sell_order as order_id, quantity from public.matches where status = 'settled'
      ) x
     group by x.order_id
  ) s
 where o.id = s.order_id;

-- ---------------------------------------------------------------------------
-- Audit: counters equal their rows (deferred to commit)
-- ---------------------------------------------------------------------------

create function public.check_order_counters(p_order uuid) returns void
  language plpgsql
  set search_path = ''
as $$
declare
  o public.orders;
  settled numeric;
  released numeric;
  voided numeric;
begin
  select * into o from public.orders where id = p_order;
  select coalesce(sum(m.quantity), 0) into settled
    from public.matches m
   where m.status = 'settled' and (m.buy_order = p_order or m.sell_order = p_order);
  select coalesce(sum(r.quantity) filter (where r.kind = 'released'), 0),
         coalesce(sum(r.quantity) filter (where r.kind = 'voided'), 0)
    into released, voided
    from public.match_reversals r
   where r.order_id = p_order;
  if o.settled_quantity <> settled then
    raise exception 'orders: settled_quantity % of % is not the sum of its settled matches (%)',
      o.settled_quantity, p_order, settled using errcode = 'check_violation';
  end if;
  if o.released_quantity <> released or o.voided_quantity <> voided then
    raise exception 'orders: released/voided quantity of % is not the sum of its match_reversals (%/%)',
      p_order, released, voided using errcode = 'check_violation';
  end if;
end;
$$;

create function public.orders_check_counters() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  perform public.check_order_counters(new.id);
  return null;
end;
$$;

create constraint trigger orders_check_counters
  after insert or update of settled_quantity, released_quantity, voided_quantity on public.orders
  deferrable initially deferred
  for each row execute function public.orders_check_counters();

-- A settled match counts on both orders; a failed one has exactly one reversal
-- row per order, each of the match's quantity; a settled one has none.
create function public.matches_check_outcome() returns trigger
  language plpgsql
  set search_path = ''
as $$
declare
  n integer;
  bad integer;
begin
  select count(*), count(*) filter (where r.quantity <> new.quantity
                                     or r.order_id not in (new.buy_order, new.sell_order))
    into n, bad
    from public.match_reversals r
   where r.match_id = new.id;
  if new.status = 'failed' and (n <> 2 or bad <> 0
     or (select count(distinct r.order_id) from public.match_reversals r where r.match_id = new.id) <> 2) then
    raise exception 'matches: failed match % needs one reversal per order, of its quantity', new.id
      using errcode = 'check_violation';
  end if;
  if new.status <> 'failed' and n <> 0 then
    raise exception 'matches: match % has reversals but is %', new.id, new.status using errcode = 'check_violation';
  end if;
  if new.status in ('settled', 'failed') then
    perform public.check_order_counters(new.buy_order);
    perform public.check_order_counters(new.sell_order);
  end if;
  return null;
end;
$$;

create constraint trigger matches_check_outcome
  after update of status on public.matches
  deferrable initially deferred
  for each row execute function public.matches_check_outcome();

-- A reversal belongs to a failed match, on one of its two orders, for its quantity.
create function public.match_reversals_check() returns trigger
  language plpgsql
  set search_path = ''
as $$
declare
  m public.matches;
begin
  select * into m from public.matches where id = new.match_id;
  if m.status <> 'failed' then
    raise exception 'match_reversals: match % is %, not failed', new.match_id, m.status using errcode = 'check_violation';
  end if;
  if new.order_id not in (m.buy_order, m.sell_order) or new.quantity <> m.quantity then
    raise exception 'match_reversals: not an order of match %, or not its quantity', new.match_id
      using errcode = 'check_violation';
  end if;
  perform public.check_order_counters(new.order_id);
  return null;
end;
$$;

create constraint trigger match_reversals_check
  after insert on public.match_reversals
  deferrable initially deferred
  for each row execute function public.match_reversals_check();

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table public.match_reversals enable row level security;
revoke all on public.match_reversals from anon, authenticated, service_role;
-- The audit trail is append-only, for the service too.
grant select, insert on public.match_reversals to service_role;

-- The public book reads the net quantities.
grant select (released_quantity, voided_quantity) on public.orders to anon, authenticated;

create or replace view public.order_book with (security_invoker = true) as
  select
    chain_id,
    asset,
    side,
    limit_price as price,
    lot_size,
    sum(quantity - (filled_quantity - released_quantity - voided_quantity))::public.base_units as quantity,
    count(*) as orders
  from public.orders
  where status in ('open', 'partially_filled') and expires_at > now()
  group by chain_id, asset, side, limit_price, lot_size;

revoke execute on function public.check_order_counters(uuid), public.orders_check_counters(),
  public.matches_check_outcome(), public.match_reversals_check()
  from public, anon, authenticated;
-- Called from the trigger functions, which run as the writing role.
grant execute on function public.check_order_counters(uuid) to service_role;
