import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { ApiClient } from "../src/client/api.js";
import { Session } from "../src/client/session.js";
import { writeLink } from "../src/client/config.js";
import type { Decision } from "../src/core/types.js";
import { createApp } from "../src/server/app.js";
import { migrate, openPglite, openPostgres, type Db } from "../src/server/db.js";
import type { Extractor } from "../src/server/extract.js";
import { Hub } from "../src/server/hub.js";
import { Repo } from "../src/server/repo.js";

export const tmp = (prefix = "de-test-") => mkdtempSync(join(tmpdir(), prefix));

/** Embedded Postgres by default; a throwaway database on a real server when TEST_DATABASE_URL is set. */
async function testDb(): Promise<Db> {
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin) return openPglite();
  const name = `de_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const root = await openPostgres(admin);
  await root.query(`CREATE DATABASE ${name}`);
  await root.close();
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return openPostgres(url.toString());
}

export async function startTestServer(opts: { extractor?: Extractor } = {}) {
  const db = await testDb();
  await migrate(db);
  const repo = new Repo(db);
  const hub = new Hub(db);
  await hub.start();
  const app = createApp(repo, hub, { heartbeatMs: 200, extractor: opts.extractor });
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const port = (server.address() as any).port;
  const url = `http://127.0.0.1:${port}`;
  const { token, member, workspace } = await new ApiClient(url).setup({ workspace: "Acme", name: "Matt", email: "matt@example.com" });
  return {
    url,
    repo,
    app,
    db,
    token,
    member,
    workspace,
    api: new ApiClient(url, token),
    close: async () => {
      (server as any).closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      await hub.stop();
      await db.close();
    },
  };
}

/** A git repository linked to `server`, with isolated config and cache dirs. */
export function linkedRepo(server: string, token: string, project = "web") {
  const root = tmp("de-repo-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  writeLink(root, { server, project });
  process.env.DE_CACHE_DIR = tmp("de-cache-");
  process.env.DE_CONFIG_DIR = tmp("de-config-");
  process.env.DE_TOKEN = token;
  delete process.env.DE_SERVER;
  delete process.env.DE_PROJECT;
  return { root, session: Session.open(root), write: (p: string, s: string) => writeFileSync(join(root, p), s) };
}

export const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

export const decision = (id: string, over: Partial<Decision> = {}): Decision => ({
  id, title: id, status: "accepted", date: "2026-01-01", tags: [], scope: [], projects: [], rejected: [], why: "because",
  depends_on: [], supersedes: [], rules: [], body: "", revision: 1, ...over,
});

export async function until(fn: () => boolean | Promise<boolean>, ms = 5_000) {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}
