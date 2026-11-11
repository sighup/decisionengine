import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiClient, ApiError } from "../src/client/api.js";
import { startTestServer } from "./helpers.js";

let srv: Awaited<ReturnType<typeof startTestServer>>;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => srv.close());

describe("service", () => {
  it("only allows setup once and requires a valid token", async () => {
    await expect(new ApiClient(srv.url).setup({ workspace: "X", name: "Y", email: "y@example.com" })).rejects.toThrow(/already set up/);
    await expect(new ApiClient(srv.url, "de_nope").me()).rejects.toMatchObject({ status: 401 });
    const me = await srv.api.me();
    expect(me.workspace.name).toBe("Acme");
    expect(me.member.role).toBe("owner");
  });

  it("records decisions with sequential keys, validates references and supersedes atomically", async () => {
    const a = await srv.api.create({ title: "Build for regulated teams first", why: "Customers are in healthcare", discipline: "business" });
    const b = await srv.api.create({
      title: "Sessions over JWTs",
      why: "Revocation must be instant",
      rejected: [{ option: "JWT", reason: "cannot revoke" }],
      depends_on: [a.decision.id],
      scope: ["src/auth/**"],
      rules: [{ type: "forbid_dependency", packages: ["jsonwebtoken"] }],
    });
    expect([a.decision.id, b.decision.id]).toEqual(["DEC-001", "DEC-002"]);
    expect(b.decision.author).toBe("Matt");
    await expect(srv.api.create({ title: "x", depends_on: ["DEC-404"] })).rejects.toThrow(/no decision DEC-404/);
    await expect(srv.api.create({ title: "x", rules: [{ type: "forbid_pattern", pattern: "(" }] })).rejects.toMatchObject({ status: 400 });

    const c = await srv.api.create({ title: "Redis session store", depends_on: ["2"] });
    const s = await srv.api.create({ title: "Short-lived sessions with rotation", supersedes: ["DEC-002"] });
    expect(s.warnings).toEqual([`${c.decision.id} built on DEC-002; re-examine them`]);
    const old = (await srv.api.decision("DEC-002")).decision;
    expect(old).toMatchObject({ status: "superseded", superseded_by: s.decision.id, revision: 2 });
    await expect(srv.api.create({ title: "again", supersedes: ["DEC-002"] })).rejects.toMatchObject({ status: 409 });
    const { issues } = await srv.api.lint();
    expect(issues.some((i) => i.id === c.decision.id && i.message.includes("superseded"))).toBe(true);
  });

  it("allocates unique keys under concurrent writes", async () => {
    const out = await Promise.all(Array.from({ length: 8 }, (_, i) => srv.api.create({ title: `Concurrent ${i}` })));
    const ids = out.map((o) => o.decision.id);
    expect(new Set(ids).size).toBe(8);
  });

  it("keeps a revision for every edit and rejects cycles", async () => {
    const { decision } = await srv.api.update("DEC-001", { why: "Healthcare and finance customers", note: "clarified" });
    expect(decision.revision).toBe(2);
    const { revisions } = await srv.api.revisions("DEC-001");
    expect(revisions.map((r) => [r.revision, r.note])).toEqual([[1, "recorded"], [2, "clarified"]]);
    expect(revisions[0].snapshot.why).toBe("Customers are in healthcare");
    await expect(srv.api.update("DEC-001", { depends_on: ["DEC-003"] })).rejects.toThrow(/cycle/);
    await expect(srv.api.update("DEC-001", { status: "superseded" })).rejects.toMatchObject({ status: 400 });
  });

  it("scopes decisions to projects", async () => {
    await srv.api.upsertProject({ slug: "web" });
    await srv.api.upsertProject({ slug: "api" });
    await srv.api.create({ title: "Tailwind for styling", projects: ["web"] });
    const web = await srv.api.decisions("web");
    const api = await srv.api.decisions("api");
    expect(web.decisions.some((d) => d.title === "Tailwind for styling")).toBe(true);
    expect(api.decisions.some((d) => d.title === "Tailwind for styling")).toBe(false);
    expect(api.decisions.some((d) => d.id === "DEC-001")).toBe(true);
  });

  it("invites members with role checks", async () => {
    const { token, member } = await srv.api.invite({ name: "Dana", email: "dana@example.com" });
    expect(member.role).toBe("member");
    const dana = new ApiClient(srv.url, token);
    expect((await dana.me()).member.name).toBe("Dana");
    await expect(dana.invite({ name: "Eve", email: "eve@example.com" })).rejects.toMatchObject({ status: 403 });
    await expect(srv.api.invite({ name: "Dana2", email: "DANA@example.com" })).rejects.toMatchObject({ status: 409 });
    const { decision } = await dana.create({ title: "Members, not Users", why: "Customer research" });
    expect(decision.author).toBe("Dana");
  });

  it("aggregates enforcement stats and a digest", async () => {
    await srv.api.reportChecks([
      { project: "web", source: "hook", agent: "claude-code", files: ["package.json"], checked: ["DEC-001", "DEC-004"], violations: [{ id: "DEC-001", path: "package.json", line: 3 }], blocked: true },
      { project: "web", source: "ci", files: ["a.ts"], checked: ["DEC-001"], violations: [], blocked: false },
    ]);
    const { stats, totals } = await srv.api.stats(7);
    expect(stats["DEC-001"]).toMatchObject({ checks: 2, violations: 1, blocked: 1 });
    expect(totals).toEqual({ checks: 2, blocked: 1, violations: 1 });
    const { markdown } = await srv.api.digest(7);
    expect(markdown).toContain("Members, not Users");
    expect(markdown).toContain("1 violation(s) caught");
    await expect(srv.api.reportChecks([{ source: "nope" } as any])).rejects.toBeInstanceOf(ApiError);
  });

  it("streams changes to subscribers in real time and resumes from Last-Event-ID", async () => {
    const res = await fetch(`${srv.url}/v1/stream`, { headers: { authorization: `Bearer ${srv.token}` } });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    const next = async (pred: (s: string) => boolean) => {
      while (!pred(buf)) buf += (await reader.read()).value ?? "";
    };
    await next((b) => b.includes("event: ready"));
    await srv.api.create({ title: "Postgres for persistence" });
    await next((b) => b.includes("event: decision.created"));
    expect(buf).toContain("Postgres for persistence");
    const lastId = /id: (\d+)/.exec(buf.slice(buf.indexOf("event: decision.created") - 40))?.[1];
    await reader.cancel();

    await srv.api.create({ title: "Missed while offline" });
    const res2 = await fetch(`${srv.url}/v1/stream`, { headers: { authorization: `Bearer ${srv.token}`, "last-event-id": lastId! } });
    const r2 = res2.body!.pipeThrough(new TextDecoderStream()).getReader();
    let b2 = "";
    while (!b2.includes("Missed while offline")) b2 += (await r2.read()).value ?? "";
    await r2.cancel();
  });
});
