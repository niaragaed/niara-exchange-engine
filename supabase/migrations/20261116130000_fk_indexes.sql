-- Indexes covering two composite foreign keys of 20261116120000_exchange_schema
-- (Supabase lint "unindexed foreign keys"). No data or behavior change.
-- TESTNET ONLY: no real assets, no real money.
--
-- matches (chain_id, asset) -> listings (chain_id, asset)
-- settlements (match_id, chain_id) -> matches (id, chain_id)
--
-- Plain CREATE INDEX (not CONCURRENTLY): migrations run in a transaction, and
-- the tables are small on the dev project.

create index matches_chain_asset_idx on public.matches (chain_id, asset);

create index settlements_match_chain_idx on public.settlements (match_id, chain_id);
