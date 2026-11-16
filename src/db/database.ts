/**
 * The minimal database surface the order service uses. Two implementations: `pg.ts`
 * (production, one connection to the Supabase Postgres) and PGlite in the tests.
 *
 * Values: parameters are passed as text or numbers; every `base_units` column is read
 * back as text (`::text`) and parsed with `BigInt`, so no amount ever goes through a
 * float.
 */
export interface Queryable {
  query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export interface Database extends Queryable {
  /** Runs `fn` in one transaction: COMMIT when it resolves, ROLLBACK when it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Postgres error code of a unique violation. */
export const UNIQUE_VIOLATION = "23505";

export function pgErrorCode(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null && "code" in e && typeof (e as { code: unknown }).code === "string") {
    return (e as { code: string }).code;
  }
  return undefined;
}
