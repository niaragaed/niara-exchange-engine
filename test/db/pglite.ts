/**
 * TEST ONLY: an in-memory PGlite (Postgres 17 in WASM, in this process) with the real
 * migrations of `supabase/migrations`, wrapped in the `Database` interface. Nothing is
 * applied to any Supabase project. The Supabase roles are recreated with the
 * attributes that matter: `service_role` bypasses RLS, `anon`/`authenticated` don't.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Database, Queryable } from "../../src/db/database.ts";

const MIGRATIONS = join(import.meta.dirname, "../../supabase/migrations");

export interface TestDb {
  pglite: PGlite;
  db: Database;
}

/** `before`: apply only the migrations whose file name sorts before it. */
export async function startPglite(options: { before?: string } = {}): Promise<TestDb> {
  const pglite = await PGlite.create();
  await pglite.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
  `);
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    if (options.before !== undefined && file >= options.before) break;
    await applyMigration(pglite, file);
  }
  return { pglite, db: pgliteDatabase(pglite) };
}

export async function applyMigration(pglite: PGlite, file: string): Promise<void> {
  await pglite.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
}

export function pgliteDatabase(pglite: PGlite): Database {
  const wrap = (q: { query: PGlite["query"] }): Queryable => ({
    query: async <T>(sql: string, params: readonly unknown[] = []) => {
      const r = await q.query<T>(sql, [...params]);
      return { rows: r.rows };
    },
  });
  return {
    ...wrap(pglite),
    transaction: (fn) => pglite.transaction((tx) => fn(wrap(tx))),
    // Each test file closes its own PGlite in afterAll.
    close: async () => undefined,
  };
}

/** Empties orders, matches, settlements and listings, and resets the chains' config. */
export async function resetData(pglite: PGlite): Promise<void> {
  await pglite.exec(`
    delete from public.settlements;
    delete from public.match_reversals;
    delete from public.matches;
    delete from public.orders;
    delete from public.listings;
    update public.chains set settlement_program = null, quote_asset = null, min_order_notional = 0,
      max_intent_validity_secs = 2592000;
  `);
}
