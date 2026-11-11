import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { importAdrs } from "../src/adr.js";
import { addedLines, changesFromShell, installClaudeCode, runPreToolUse, sessionStartContext } from "../src/agent/hooks.js";
import { createMcpServer } from "../src/agent/mcp.js";
import { ApiClient } from "../src/client/api.js";
import { DecisionCache, watch } from "../src/client/cache.js";

import { collectGitChanges, parseUnifiedDiff } from "../src/git.js";
import { linkedRepo, sh, startTestServer, tmp, until } from "./helpers.js";

let srv: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => {
  srv = await startTestServer();
  await srv.api.upsertProject({ slug: "web" });
  await srv.api.create({
    title: "Sessions over JWTs",
    why: "Revocation must be instant. Token expiry failed review.",
    rejected: [{ option: "JWT bearer tokens" }],
    scope: ["src/auth/**"],
    rules: [{ type: "forbid_pattern", pattern: "jwt\\.sign" }, { type: "forbid_dependency", packages: ["jsonwebtoken", "jose"] }],
  });
  await srv.api.create({ title: "Only in the API project", projects: ["api"], rules: [{ type: "forbid_pattern", pattern: "TODO" }] });
});
afterAll(async () => srv.close());

describe("local cache", () => {
  it("serves fresh snapshots, falls back to stale ones when the service is down, and queues telemetry", async () => {
    const { session } = linkedRepo(srv.url, srv.token);
    const live = await session.cache.get();
    expect(live.source).toBe("live");
    expect((await session.cache.get()).source).toBe("cache");

    const offline = new DecisionCache(new ApiClient("http://127.0.0.1:9", srv.token));
    writeFileSync(offline.file, JSON.stringify({ server: "x", seq: 1, fresh_at: 0, decisions: live.decisions }));
    const stale = await offline.get({ timeoutMs: 300 });
    expect(stale).toMatchObject({ stale: true, source: "cache" });
    expect(stale.decisions.length).toBe(live.decisions.length);

    await offline.report({ source: "hook", files: ["a"], checked: ["DEC-001"], violations: [], blocked: false }, 300);
    expect(readFileSync(offline.outbox, "utf8")).toContain("DEC-001");
    // Same outbox, reachable server: the queued event is flushed with the next report.
    const online = new DecisionCache(new ApiClient(srv.url, srv.token));
    writeFileSync(online.outbox, readFileSync(offline.outbox));
    await online.report({ source: "hook", files: ["b"], checked: ["DEC-001"], violations: [], blocked: false });
    expect(existsSync(online.outbox)).toBe(false);
    expect((await srv.api.stats(7)).stats["DEC-001"].checks).toBeGreaterThanOrEqual(2);
  });

  it("stays current from the live feed when a teammate records a decision", async () => {
    const { session } = linkedRepo(srv.url, srv.token);
    await session.cache.refresh();
    const stop = watch(session.cache);
    try {
      await until(async () => (await fetch(`${srv.url}/healthz`)).ok);
      await new Promise((r) => setTimeout(r, 300)); // let the stream connect
      const { token } = await srv.api.invite({ name: "Teammate", email: `t${Date.now()}@example.com` });
      await new ApiClient(srv.url, token).create({ title: "Feature flags via config service" });
      await until(() => !!session.cache.read()?.decisions.some((d) => d.title === "Feature flags via config service"));
    } finally {
      stop();
    }
  });
});

describe("Claude Code hooks", () => {
  it("computes added lines and parses package installs", () => {
    expect(addedLines("a\nb\nb", "a\nb\nc\nb\nb")).toEqual([{ line: 3, text: "c" }, { line: 5, text: "b" }]);
    const c = changesFromShell("cd web && npm i -D @types/node jsonwebtoken@9 && pip install 'pyjwt>=2' -q");
    expect(c.find((x) => x.path === "package.json")?.addedLines?.map((l) => l.text)).toEqual(['"@types/node": "*"', '"jsonwebtoken": "*"']);
    expect(c.find((x) => x.path === "requirements.txt")?.addedLines?.map((l) => l.text)).toEqual(["pyjwt"]);
  });

  it("blocks edits and installs that break a decision, allows clean ones, and reports to the service", async () => {
    const { root, session, write } = linkedRepo(srv.url, srv.token);
    mkdirSync(join(root, "src/auth"), { recursive: true });
    write("src/auth/login.ts", "export const a = 1;\n");
    const bad = await runPreToolUse(session, {
      tool_name: "Edit",
      cwd: root,
      tool_input: { file_path: join(root, "src/auth/login.ts"), old_string: "export const a = 1;", new_string: "export const a = jwt.sign(u);" },
    });
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain("Sessions over JWTs");
    expect(bad.stderr).toContain("Revocation must be instant");

    const install = await runPreToolUse(session, { tool_name: "Bash", cwd: root, tool_input: { command: "npm install jose" } });
    expect(install.exitCode).toBe(2);

    const ok = await runPreToolUse(session, { tool_name: "Write", cwd: root, tool_input: { file_path: join(root, "src/auth/login.ts"), content: "export const a = createSession(u);\n" } });
    expect(ok.exitCode).toBe(0);

    // A decision limited to another project does not apply here.
    const other = await runPreToolUse(session, { tool_name: "Write", cwd: root, tool_input: { file_path: join(root, "notes.ts"), content: "// TODO\n" } });
    expect(other.exitCode).toBe(0);

    const { checks } = await srv.api.request<any>("GET", "/v1/checks");
    expect(checks.some((c: any) => c.blocked && c.project === "web" && c.agent === "claude-code")).toBe(true);
  });

  it("injects a session summary and installs idempotently", async () => {
    const { root, session } = linkedRepo(srv.url, srv.token);
    expect(await sessionStartContext(session)).toContain("Sessions over JWTs [src/auth/**] — Revocation must be instant.");
    installClaudeCode(root);
    installClaudeCode(root);
    const settings = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8"));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers.decisionengine).toEqual({ command: "de", args: ["mcp"] });
  });
});

describe("git", () => {
  it("parses unified diffs", () => {
    const diff = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -2,0 +3,2 @@", "+one", "+two", "diff --git a/g b/g", "--- a/g", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye"].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([{ path: "src/a.ts", addedLines: [{ line: 3, text: "one" }, { line: 4, text: "two" }] }]);
  });

  it("collects working-tree, untracked, first-commit and base-branch changes", () => {
    const { root, write } = linkedRepo(srv.url, srv.token);
    write("a.ts", "x\n");
    sh(root, "add", "a.ts");
    write("a.ts", "x\ny\n");
    expect(collectGitChanges(root).find((c) => c.path === "a.ts")?.content).toBe("x\ny\n");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "init");
    write("a.ts", "x\ny\nnew\n");
    write("b.ts", "fresh\n");
    const changes = collectGitChanges(root);
    expect(changes.find((c) => c.path === "a.ts")?.addedLines).toEqual([{ line: 3, text: "new" }]);
    expect(changes.find((c) => c.path === "b.ts")?.content).toBe("fresh\n");
    sh(root, "checkout", "-qb", "feature");
    sh(root, "add", "-A");
    sh(root, "commit", "-qm", "feat");
    expect(collectGitChanges(root, { base: "main" }).map((c) => c.path).sort()).toEqual(["a.ts", "b.ts"]);
  });
});

describe("MCP server", () => {
  it("recalls, records and checks decisions for an agent", async () => {
    const { session } = linkedRepo(srv.url, srv.token);
    const server = createMcpServer(session);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r: any = await client.callTool({ name, arguments: args });
      return { text: r.content[0].text as string, isError: !!r.isError };
    };

    const ctx = await call("decisions_for_paths", { paths: ["src/auth/session.ts"] });
    expect(ctx.text).toContain("Sessions over JWTs");
    expect(ctx.text).toContain("JWT bearer tokens");
    expect((await call("decisions_for_paths", { paths: ["README.md"] })).text).not.toContain("Sessions over JWTs");

    const rec = await call("record_decision", { title: "Postgres for persistence", why: "Transactions", rejected: [{ option: "MongoDB" }], rules: [{ type: "forbid_dependency", packages: ["mongoose"] }], project_only: true });
    expect(rec.text).toMatch(/Recorded DEC-\d+: Postgres for persistence/);
    const created = (await srv.api.decisions()).decisions.find((d) => d.title === "Postgres for persistence")!;
    expect(created).toMatchObject({ projects: ["web"], source: "mcp" });

    expect((await call("check_change", { files: [{ path: "package.json", content: '{\n  "mongoose": "^8"\n}' }] })).text).toContain("forbidden dependency");
    expect((await call("check_change", { files: [{ path: "package.json", content: '{\n  "pg": "^8"\n}' }] })).text).toContain("No decision violations");
    expect((await call("list_decisions", { query: "mongodb" })).text).toContain(created.id);
    expect((await call("get_decision", { id: created.id })).text).toContain(`### ${created.id}`);
    expect((await call("record_decision", { title: "x", why: "y", depends_on: ["DEC-099"] })).isError).toBe(true);
    expect((await call("decision_digest", { days: 7 })).text).toContain("Postgres for persistence");
  });
});

describe("ADR import", () => {
  it("imports Nygard and MADR records with supersession chains", async () => {
    const dir = tmp("de-adr-");
    writeFileSync(join(dir, "0001-postgres.md"), "# 1. Use PostgreSQL\n\nDate: 2024-02-01\n\n## Status\n\nSuperseded by [3. CockroachDB](0003-crdb.md)\n\n## Decision\n\nWe will use PostgreSQL.\n");
    writeFileSync(join(dir, "0002-api.md"), '---\nstatus: accepted\ndate: 2024-03-10\n---\n# REST over GraphQL\n\n## Considered Options\n\n* REST\n* GraphQL\n\n## Decision Outcome\n\nChosen option: "REST", because caching is easy.\n');
    writeFileSync(join(dir, "0003-crdb.md"), "# 3. Use CockroachDB\n\n## Status\n\nAccepted\n\nSupersedes [1. PostgreSQL](0001-postgres.md)\n\n## Decision\n\nMulti-region writes.\n");
    writeFileSync(join(dir, "README.md"), "# ADRs\n");
    const out = await importAdrs(srv.api, dir);
    expect(out.map((d) => [d.title, d.status])).toEqual([["Use PostgreSQL", "superseded"], ["REST over GraphQL", "accepted"], ["Use CockroachDB", "accepted"]]);
    expect(out[0].superseded_by).toBe(out[2].id);
    expect(out[1]).toMatchObject({ why: "caching is easy.", rejected: [{ option: "GraphQL" }], date: "2024-03-10", source: "import" });
  });
});


