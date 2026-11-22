-- Niara Exchange: listing metadata (symbol and name). TESTNET ONLY.
--
-- The listing syncs (scripts/sync-solana-listings.ts, scripts/sync-evm-listings.ts)
-- copy each token's own on-chain metadata here: the Token-2022 TokenMetadata
-- extension of a Solana mint, symbol() and name() of an EVM token. Null when the
-- token publishes none, or a value the checks below refuse: never guessed, never
-- taken from a config file.
--
-- Display only: nothing matches, settles or signs on them, and a symbol is not
-- unique (anyone can deploy a token called "USDT"); the asset address is the
-- identity. Public reads: anon and authenticated already hold a table-level select
-- on public.listings (migration 20261116120000), which covers these columns, under
-- the same row policy (approved equity and currency listings only).

alter table public.listings
  add column symbol text
    constraint listings_symbol_check
    check (symbol is null or (char_length(symbol) between 1 and 32 and symbol !~ '[[:cntrl:]]' and symbol = btrim(symbol))),
  add column name text
    constraint listings_name_check
    check (name is null or (char_length(name) between 1 and 128 and name !~ '[[:cntrl:]]' and name = btrim(name)));

comment on column public.listings.symbol is
  'Token symbol as published on-chain (Token-2022 metadata / ERC-20 symbol()); display only, not unique. Null if none.';
comment on column public.listings.name is
  'Token name as published on-chain (Token-2022 metadata / ERC-20 name()); display only. Null if none.';
