import pg from "pg";
import type { Database, Queryable } from "./database.ts";

/**
 * Production database: ONE `pg` connection for the whole process.
 *
 * One connection on purpose: the single-instance advisory lock (`repository.ts`) is a
 * session lock, so it lives exactly as long as this connection. If the connection is
 * lost, the lock is gone too, and `onLost` must stop the process (another instance may
 * take over). Calls are queued, so a transaction never interleaves with another query.
 *
 * Use a direct or session-mode connection string (Supabase port 5432), never the
 * transaction pooler (port 6543): a pooled connection would not keep the session lock.
 */
export async function connectPg(connectionString: string, onLost: (err: Error) => void): Promise<Database> {
  const client = new pg.Client({ connectionString, application_name: "niara-order-service" });
  client.on("error", onLost);
  client.on("end", () => onLost(new Error("database connection ended")));
  await client.connect();
  return pgDatabase(client);
}

/** Minimal client surface, so the adapter can be tested without a server. */
export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export function pgDatabase(client: PgClientLike): Database {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };
  const raw: Queryable = {
    query: async <T>(sql: string, params: readonly unknown[] = []) =>
      (await client.query(sql, [...params])) as { rows: T[] },
  };
  return {
    query: (sql, params) => serial(() => raw.query(sql, params)),
    transaction: (fn) =>
      serial(async () => {
        await client.query("begin");
        try {
          const result = await fn(raw);
          await client.query("commit");
          return result;
        } catch (e) {
          await client.query("rollback").catch(() => undefined);
          throw e;
        }
      }),
    close: () => serial(() => client.end()),
  };
}
