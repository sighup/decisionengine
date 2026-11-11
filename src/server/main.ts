import { serve } from "@hono/node-server";
import { homedir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";
import { openDb, type Db } from "./db.js";
import { defaultExtractor } from "./extract.js";
import { Hub } from "./hub.js";
import { Repo } from "./repo.js";

export interface ServerOptions {
  port: number;
  host: string;
  databaseUrl?: string;
  dataDir?: string;
}

export function defaultDataDir(): string {
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(base, "decisionengine", "pgdata");
}

export async function startServer(opts: ServerOptions): Promise<{ url: string; close: () => Promise<void>; db: Db; capture: boolean }> {
  const db = await openDb({ databaseUrl: opts.databaseUrl, dataDir: opts.databaseUrl ? undefined : opts.dataDir ?? defaultDataDir() });
  const repo = new Repo(db);
  const hub = new Hub(db);
  await hub.start();
  const extractor = defaultExtractor();
  const app = createApp(repo, hub, { extractor });
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  return {
    url: `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${port}`,
    db,
    capture: !!extractor,
    close: async () => {
      await new Promise<void>((r) => {
        (server as any).closeAllConnections?.();
        server.close(() => r());
      });
      await hub.stop();
      await db.close();
    },
  };
}
