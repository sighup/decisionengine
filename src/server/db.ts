import { mkdirSync } from "node:fs";
import { MIGRATIONS } from "./schema.js";

/**
 * Minimal database interface implemented by node-postgres (production) and
 * PGlite (embedded Postgres for local/single-node use and tests). Both speak
 * the same SQL, so there is one schema and one query layer.
 */
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Subscribe to NOTIFY on a channel. Returns an unsubscribe function. */
  listen(channel: string, fn: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
  readonly kind: "postgres" | "pglite";
}

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
}

export async function openPostgres(connectionString: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString, max: 10 });
  let listener: import("pg").PoolClient | undefined;
  const handlers = new Map<string, Set<(p: string) => void>>();
  const db: Db = {
    kind: "postgres",
    async query(sql, params) {
      return (await pool.query(sql, params as any[])).rows;
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({ query: async (sql, params) => (await client.query(sql, params as any[])).rows });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async listen(channel, fn) {
      if (!listener) {
        listener = await pool.connect();
        listener.on("notification", (n) => handlers.get(n.channel)?.forEach((h) => h(n.payload ?? "")));
      }
      if (!handlers.has(channel)) {
        handlers.set(channel, new Set());
        await listener.query(`LISTEN ${channel}`);
      }
      handlers.get(channel)!.add(fn);
      return async () => {
        handlers.get(channel)?.delete(fn);
      };
    },
    async close() {
      listener?.release();
      await pool.end();
    },
  };
  return db;
}

export async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const pg = new PGlite(dataDir);
  await pg.waitReady;
  // PGlite is single-connection; serialise transactions so they never interleave.
  let chain: Promise<unknown> = Promise.resolve();
  const db: Db = {
    kind: "pglite",
    async query(sql, params) {
      await chain;
      return (await pg.query(sql, params as any[])).rows as any[];
    },
    transaction(fn) {
      const run = chain.then(() => pg.transaction((tx) => fn({ query: async (sql, params) => (await tx.query(sql, params as any[])).rows as any[] })));
      chain = run.catch(() => {});
      return run;
    },
    async listen(channel, fn) {
      const unsub = await pg.listen(channel, fn);
      return async () => unsub();
    },
    async close() {
      await pg.close();
    },
  };
  return db;
}

export async function openDb(opts: { databaseUrl?: string; dataDir?: string }): Promise<Db> {
  const db = opts.databaseUrl ? await openPostgres(opts.databaseUrl) : await openPglite(opts.dataDir);
  await migrate(db);
  return db;
}

export async function migrate(db: Db): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ version: number }>(`SELECT version FROM schema_migrations`)).map((r) => r.version));
  for (const [i, sql] of MIGRATIONS.entries()) {
    const version = i + 1;
    if (done.has(version)) continue;
    await db.transaction(async (tx) => {
      for (const stmt of sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) await tx.query(stmt);
      await tx.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [version]);
    });
  }
}
