-- Niara Exchange off-chain schema (Supabase `niara-exchange-dev`, Postgres 17).
-- Spec: niara-exchange-solana/EXCHANGE-MULTICHAIN-DESIGN.md §5, extended (see
-- docs/decisions.md). TESTNET ONLY: no real assets, no real money.
--
-- Units: every quantity, price and amount is an integer in base units
-- (`public.base_units`), never a float.
--   quantity        asset base units, a multiple of lot_size
--   limit_price     USDT base units per lot_size asset base units
--   payment_amount  quantity / lot_size * price (exact)
--
-- Access: RLS on every table. `anon` and `authenticated` read only what the
-- public order book needs (chains, approved equity/currency listings, and the
-- price-level columns of live orders, aggregated in `order_book`). Clients write
-- nothing: orders are inserted by the server function that verifies the
-- wallet's signature over the order intent, with the service role.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

-- uint256 range, integers only. A plain numeric with a check, not numeric(78,0):
-- numeric(78,0) would silently round 1.5 to 2 instead of rejecting it.
create domain public.base_units as numeric
  check (
    value >= 0
    and value = trunc(value)
    and value < 115792089237316195423570985008687907853269984665640564039457584007913129639936
  );

create type public.chain_kind as enum ('solana', 'evm');

-- Spec §1 / §3.2 (lowercase, snake_case).
create type public.asset_class as enum ('equity', 'fixed_income', 'credit', 'currency');
create type public.listing_status as enum ('pending', 'quoted', 'approved', 'suspended', 'delisted');

create type public.order_side as enum ('buy', 'sell');

-- open             live, nothing filled
-- partially_filled live, part filled
-- filled           terminal
-- cancelled        terminal: by the wallet, or by self-trade prevention
-- expired          terminal: expires_at reached
-- stale            not matchable: the on-chain delegate/allowance no longer covers
--                  it (spec §3.5); may return to open/partially_filled
create type public.order_status as enum (
  'open', 'partially_filled', 'filled', 'cancelled', 'expired', 'stale'
);

-- pending   matched, not yet submitted
-- settling  submitted to the chain
-- settled   confirmed on-chain (terminal)
-- failed    the chain rejected it, or it expired before settling (terminal)
create type public.match_status as enum ('pending', 'settling', 'settled', 'failed');

create type public.settlement_status as enum ('pending', 'submitted', 'confirmed', 'failed');

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create function public.set_updated_at() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- chains
-- ---------------------------------------------------------------------------

create table public.chains (
  id text primary key
    check (id in ('solana-devnet', 'base-sepolia', 'robinhood-testnet', 'hyperevm-testnet', 'tempo-testnet')),
  kind public.chain_kind not null,
  -- CAIP-2 id, the chain id signed in order intents.
  caip2 text not null unique,
  evm_chain_id bigint unique,
  -- Solana program id / EVM NiaraSettlement address. Null until deployed.
  settlement_program text,
  -- USDT mint / token on this chain: the only payment asset of the order book
  -- (spec §3.4). Null until set up.
  quote_asset text,
  -- Spec §9.12 item 1: orders below this notional (USDT base units) are refused.
  -- 0 = no minimum (testnet); set per chain from its cost per settle.
  min_order_notional public.base_units not null default 0,
  -- Maximum order intent validity: expires_at <= signing time + this. Spec §9.12
  -- item 2 needs a window; proposed to the spec, mirrored on-chain later.
  max_intent_validity_secs integer not null default 2592000
    check (max_intent_validity_secs > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'evm') = (evm_chain_id is not null))
);

create trigger chains_updated_at before update on public.chains
  for each row execute function public.set_updated_at();

insert into public.chains (id, kind, caip2, evm_chain_id) values
  ('solana-devnet',     'solana', 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', null),
  ('base-sepolia',      'evm',    'eip155:84532', 84532),
  ('robinhood-testnet', 'evm',    'eip155:46630', 46630),
  ('hyperevm-testnet',  'evm',    'eip155:998',   998),
  ('tempo-testnet',     'evm',    'eip155:42431', 42431);

-- ---------------------------------------------------------------------------
-- listings: mirror of on-chain listings, written by the indexer (spec §5)
-- ---------------------------------------------------------------------------

create table public.listings (
  id uuid primary key default gen_random_uuid(),
  chain_id text not null references public.chains (id),
  -- Mint (Solana, base58) or token address (EVM).
  asset text not null,
  -- Null for a currency (no issuer, spec §4.1).
  issuer text,
  asset_class public.asset_class not null,
  status public.listing_status not null,
  cashback_eligible boolean not null,
  -- Offering document hash, 32 bytes hex. Null for a currency.
  doc_hash text check (doc_hash ~ '^[0-9a-f]{64}$'),
  asset_decimals smallint not null check (asset_decimals between 0 and 255),
  -- Off-chain market parameter: order quantities are whole lots and prices are
  -- per lot. Changing it while orders rest would change their meaning, so the
  -- signed intent carries it and must match.
  lot_size public.base_units not null check (lot_size > 0),
  -- Last indexed transaction that changed this listing.
  tx_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chain_id, asset),
  check (
    asset_class <> 'currency'
    or (issuer is null and cashback_eligible = false and doc_hash is null)
  )
);

create trigger listings_updated_at before update on public.listings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- orders: one row per verified order intent
-- ---------------------------------------------------------------------------

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  -- Arrival order: time priority in the book.
  seq bigint generated always as identity unique,
  chain_id text not null references public.chains (id),
  asset text not null,
  -- Signed intent fields (src/intents). Immutable after insert.
  side public.order_side not null,
  quantity public.base_units not null check (quantity > 0),
  lot_size public.base_units not null check (lot_size > 0),
  limit_price public.base_units not null check (limit_price > 0),
  payment_asset text not null,
  wallet text not null,
  nonce text not null check (nonce ~ '^[0-9a-f]{32}$'),
  expires_at timestamptz not null,
  intent_version smallint not null check (intent_version > 0),
  intent_signature text not null,
  -- Engine state.
  filled_quantity public.base_units not null default 0,
  status public.order_status not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (chain_id, asset) references public.listings (chain_id, asset),
  -- One order per signed nonce: a signed intent cannot be submitted twice.
  unique (chain_id, wallet, nonce),
  check (quantity % lot_size = 0),
  check (filled_quantity <= quantity and filled_quantity % lot_size = 0),
  check (expires_at > created_at),
  check (
    case status
      when 'open' then filled_quantity = 0
      when 'partially_filled' then filled_quantity > 0 and filled_quantity < quantity
      when 'filled' then filled_quantity = quantity
      else filled_quantity < quantity
    end
  )
);

create index orders_book_idx on public.orders (chain_id, asset, side, limit_price, seq)
  where status in ('open', 'partially_filled');
create index orders_wallet_idx on public.orders (wallet);

create trigger orders_updated_at before update on public.orders
  for each row execute function public.set_updated_at();

-- Signed fields never change; fills only grow; terminal statuses stay terminal.
create function public.orders_guard_update() returns trigger
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
  if old.status in ('filled', 'cancelled', 'expired') and new.status is distinct from old.status then
    raise exception 'orders: status % is terminal', old.status using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger orders_guard_update before update on public.orders
  for each row execute function public.orders_guard_update();

-- ---------------------------------------------------------------------------
-- matches: one row per fill; id is the on-chain match_id (spec §3.4)
-- ---------------------------------------------------------------------------

create table public.matches (
  -- UUID v4 assigned by the matching engine (no default). Never all zeros
  -- (on-chain ZeroMatchId): a v4 UUID cannot be.
  id uuid primary key
    check (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  seq bigint generated always as identity unique,
  chain_id text not null references public.chains (id),
  asset text not null,
  buy_order uuid not null references public.orders (id),
  sell_order uuid not null references public.orders (id),
  -- The resting order; its limit price is the trade price.
  maker_order uuid not null,
  quantity public.base_units not null check (quantity > 0),
  lot_size public.base_units not null check (lot_size > 0),
  -- USDT base units per lot.
  price public.base_units not null check (price > 0),
  -- USDT base units the buyer pays (the on-chain payment_amount).
  payment_amount public.base_units not null check (payment_amount > 0),
  -- The earlier of the two orders' expiries.
  expires_at timestamptz not null,
  status public.match_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (chain_id, asset) references public.listings (chain_id, asset),
  unique (id, chain_id),
  check (buy_order <> sell_order),
  check (maker_order in (buy_order, sell_order)),
  check (quantity % lot_size = 0),
  check (payment_amount * lot_size = quantity * price)
);

create index matches_buy_order_idx on public.matches (buy_order);
create index matches_sell_order_idx on public.matches (sell_order);
create index matches_pending_idx on public.matches (chain_id, seq) where status in ('pending', 'settling');

create trigger matches_updated_at before update on public.matches
  for each row execute function public.set_updated_at();

-- Defense in depth for the engine's rules: same market and lot, sides right, no
-- self-match, price within both limit prices, both orders unexpired.
create function public.matches_check_orders() returns trigger
  language plpgsql
  set search_path = ''
as $$
declare
  b public.orders;
  s public.orders;
begin
  select * into b from public.orders where id = new.buy_order;
  select * into s from public.orders where id = new.sell_order;
  if b.side <> 'buy' or s.side <> 'sell' then
    raise exception 'matches: buy_order must be a buy and sell_order a sell' using errcode = 'check_violation';
  end if;
  if (b.chain_id, b.asset, b.lot_size) is distinct from (new.chain_id, new.asset, new.lot_size)
     or (s.chain_id, s.asset, s.lot_size) is distinct from (new.chain_id, new.asset, new.lot_size) then
    raise exception 'matches: orders are not in this market' using errcode = 'check_violation';
  end if;
  if b.wallet = s.wallet then
    raise exception 'matches: self-trade (wallet %)', b.wallet using errcode = 'check_violation';
  end if;
  if new.price > b.limit_price or new.price < s.limit_price then
    raise exception 'matches: price outside the limit prices' using errcode = 'check_violation';
  end if;
  if new.expires_at <> least(b.expires_at, s.expires_at) then
    raise exception 'matches: expires_at must be the earlier order expiry' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger matches_check_orders before insert on public.matches
  for each row execute function public.matches_check_orders();

-- Only status (and updated_at) may change.
create function public.matches_guard_update() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if (new.id, new.seq, new.chain_id, new.asset, new.buy_order, new.sell_order, new.maker_order,
      new.quantity, new.lot_size, new.price, new.payment_amount, new.expires_at, new.created_at)
     is distinct from
     (old.id, old.seq, old.chain_id, old.asset, old.buy_order, old.sell_order, old.maker_order,
      old.quantity, old.lot_size, old.price, old.payment_amount, old.expires_at, old.created_at) then
    raise exception 'matches: only status may change' using errcode = 'check_violation';
  end if;
  if old.status in ('settled', 'failed') and new.status is distinct from old.status then
    raise exception 'matches: status % is terminal', old.status using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger matches_guard_update before update on public.matches
  for each row execute function public.matches_guard_update();

-- ---------------------------------------------------------------------------
-- settlements: at most one per match (spec §5 idempotency)
-- ---------------------------------------------------------------------------

create table public.settlements (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null unique,
  chain_id text not null,
  tx_hash text,
  status public.settlement_status not null default 'pending',
  error text,
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The settlement is on the match's chain.
  foreign key (match_id, chain_id) references public.matches (id, chain_id),
  check (status <> 'confirmed' or tx_hash is not null),
  check (status <> 'failed' or error is not null)
);

create trigger settlements_updated_at before update on public.settlements
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security and grants
-- ---------------------------------------------------------------------------

alter table public.chains enable row level security;
alter table public.listings enable row level security;
alter table public.orders enable row level security;
alter table public.matches enable row level security;
alter table public.settlements enable row level security;

-- Supabase's default privileges grant everything on new public tables to anon,
-- authenticated and service_role. Start from nothing and grant explicitly.
revoke all on public.chains, public.listings, public.orders, public.matches, public.settlements
  from anon, authenticated, service_role;

-- The server (service role, bypasses RLS) reads and writes; nobody deletes:
-- orders, matches and settlements are the audit trail.
grant select, insert, update on public.chains, public.listings, public.orders,
  public.matches, public.settlements to service_role;

-- Public order book reads.
grant select on public.chains to anon, authenticated;
create policy chains_public_read on public.chains
  for select to anon, authenticated using (true);

grant select on public.listings to anon, authenticated;
create policy listings_public_read on public.listings
  for select to anon, authenticated
  using (status = 'approved' and asset_class in ('equity', 'currency'));

-- Price-level columns only: no id, wallet, nonce or signature.
grant select (chain_id, asset, side, limit_price, lot_size, quantity, filled_quantity, status, expires_at)
  on public.orders to anon, authenticated;
create policy orders_public_book on public.orders
  for select to anon, authenticated
  using (status in ('open', 'partially_filled') and expires_at > now());

-- matches and settlements: no client access (RLS on, no policy, no grant).

-- Aggregated book: one row per price level. security_invoker, so the caller's
-- grants and RLS apply.
create view public.order_book with (security_invoker = true) as
  select
    chain_id,
    asset,
    side,
    limit_price as price,
    lot_size,
    sum(quantity - filled_quantity)::public.base_units as quantity,
    count(*) as orders
  from public.orders
  where status in ('open', 'partially_filled') and expires_at > now()
  group by chain_id, asset, side, limit_price, lot_size;

revoke all on public.order_book from anon, authenticated, service_role;
grant select on public.order_book to anon, authenticated, service_role;

revoke execute on function public.set_updated_at(), public.orders_guard_update(),
  public.matches_check_orders(), public.matches_guard_update()
  from public, anon, authenticated;
