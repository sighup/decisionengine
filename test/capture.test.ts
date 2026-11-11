import { execFile } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { batchCommits, captureMaterial, captureSession, chooseExtraction, parseTranscript, readCommits, renderCommits } from "../src/client/capture.js";
import { extractionPrompt, fromLooseOutput, parseJsonReply } from "../src/core/extraction.js";
import { chunkText, MAX_CAPTURE_CHARS, redactSecrets } from "../src/core/capture.js";
import type { ExtractInput, Extractor, Proposal } from "../src/server/extract.js";
import { toProposals } from "../src/core/extraction.js";
import { decision, linkedRepo, sh, startTestServer, tmp } from "./helpers.js";

// Never reach for a real `claude` during tests unless a test points DE_CLAUDE_BIN at a stand-in.
process.env.DE_CAPTURE_LOCAL = "off";

/** A stand-in `claude` CLI: records its arguments and stdin, replies with $FAKE_REPLY. */
function fakeClaude(reply: object) {
  const dir = tmp("de-fake-claude-");
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
if (process.argv[2] === "--version") { console.log("2.0.0 (Claude Code)"); process.exit(0); }
const input = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(join(dir, "call.json"))}, JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd(), capture: process.env.DE_CAPTURE }));
console.log(${JSON.stringify("Here you go:\n```json\n" + JSON.stringify(reply) + "\n```")});
`,
  );
  chmodSync(bin, 0o755);
  return { bin, call: () => JSON.parse(readFileSync(join(dir, "call.json"), "utf8")) };
}

/** Stands in for Claude: returns whatever the test queued, and records what it was shown. */
class FakeExtractor implements Extractor {
  calls: ExtractInput[] = [];
  next: Proposal[] = [];
  async extract(input: ExtractInput) {
    this.calls.push(input);
    const out = this.next;
    this.next = [];
    return out;
  }
}

const raw = (over: Record<string, unknown> = {}) => ({
  title: "Use pnpm",
  why: "Faster installs",
  rejected: [],
  discipline: "engineering" as const,
  tags: [],
  scope: [],
  depends_on: [],
  supersedes: [],
  rules: [],
  evidence: "let's go with pnpm",
  ...over,
});

describe("extraction output", () => {
  it("drops duplicates (including rejected proposals), unknown links and unusable rules", () => {
    const existing = [decision("DEC-001", { title: "Sessions over JWTs" }), decision("DEC-002", { title: "Use Yarn", status: "deprecated" })];
    const out = toProposals(
      {
        decisions: [
          raw({ title: "sessions over JWTs!" }),
          raw({ title: "Use yarn" }),
          raw({
            depends_on: ["DEC-001", "DEC-999"],
            rules: [
              { type: "forbid_dependency", pattern: null, paths: [], packages: ["npm"], message: "use pnpm" },
              { type: "forbid_pattern", pattern: "(", paths: [], packages: [], message: "" },
              { type: "require_pattern", pattern: "x", paths: [], packages: [], message: "" },
            ],
          }),
          raw({ title: "Use PNPM" }),
        ],
      },
      existing,
    );
    expect(out).toHaveLength(1);
    expect(out[0].depends_on).toEqual(["DEC-001"]);
    expect(out[0].rules).toEqual([{ type: "forbid_dependency", packages: ["npm"], message: "use pnpm" }]);
  });

  it("redacts credentials and splits long material on line boundaries", () => {
    const text = "key sk-ant-api03-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuvwxyz0123456789\npassword=hunter2hunter postgres://de:secretpw@db/x";
    const r = redactSecrets(text);
    expect(r).not.toMatch(/abcdefghijklmnop|hunter2|secretpw/);
    expect(r).toContain("password=[redacted]");
    expect(r).toContain("postgres://de:[redacted]@db/x");
    const parts = chunkText("a".repeat(50) + "\n" + "b".repeat(50) + "\n" + "c".repeat(10), 70);
    expect(parts).toEqual(["a".repeat(50), "b".repeat(50) + "\n" + "c".repeat(10)]);
  });
});

describe("capture service", () => {
  const fake = new FakeExtractor();
  let srv: Awaited<ReturnType<typeof startTestServer>>;
  beforeAll(async () => {
    srv = await startTestServer({ extractor: fake });
    await srv.api.upsertProject({ slug: "web" });
  });
  afterAll(() => srv.close());

  it("without its own key, the service takes output extracted by the client's Claude", async () => {
    const plain = await startTestServer();
    try {
      expect(await plain.api.captureStatus()).toEqual({ enabled: true, server_extraction: false, max_chars: MAX_CAPTURE_CHARS });
      await expect(plain.api.capture({ source: "notes", text: "x" })).rejects.toMatchObject({ status: 501 });
      const old = (await plain.api.create({ title: "Use Yarn" })).decision;
      const res = await plain.api.capture({
        source: "notes",
        output: { decisions: [{ title: "Use pnpm", why: "faster", supersedes: [old.id, "DEC-404"], rules: [{ type: "forbid_dependency", packages: ["yarn"] }] }, { title: "use yarn" }, { why: "no title" }, "junk"] },
      });
      expect(res.proposals.map((p) => p.decision)).toEqual([expect.objectContaining({ title: "Use pnpm", status: "proposed", supersedes: [old.id], source: "capture:notes" })]);
    } finally {
      await plain.close();
    }
  });

  it("validates requests", async () => {
    await expect(srv.api.capture({ source: "slack" as any, text: "x" })).rejects.toMatchObject({ status: 400 });
    await expect(srv.api.capture({ source: "notes", text: " " })).rejects.toMatchObject({ status: 400 });
    await expect(srv.api.capture({ source: "notes", output: { decisions: [{ title: "x".repeat(MAX_CAPTURE_CHARS) }] } })).rejects.toMatchObject({ status: 413 });
    await expect(srv.api.capture({ source: "notes", text: "x".repeat(MAX_CAPTURE_CHARS + 1) })).rejects.toMatchObject({ status: 413 });
  });

  it("records proposals that only take effect, supersession included, once accepted", async () => {
    const old = (await srv.api.create({ title: "REST for the public API" })).decision;
    fake.next = [{ title: "GraphQL for the public API", why: "Clients need flexible queries", supersedes: [old.id], evidence: "ok, GraphQL it is", rules: [{ type: "forbid_dependency", packages: ["express"] }] }];
    const res = await srv.api.capture({ source: "claude-code", text: "Developer: ok, GraphQL it is", source_ref: "claude-code:abc", project: "web" });

    expect(fake.calls.at(-1)!.existing.map((d) => d.id)).toContain(old.id);
    const p = res.proposals[0].decision;
    expect(res.proposals[0].warnings).toContain(`will supersede ${old.id} when accepted`);
    expect(p).toMatchObject({ status: "proposed", source: "capture:claude-code", source_ref: "claude-code:abc", projects: ["web"], supersedes: [old.id] });
    expect(p.body).toContain("> ok, GraphQL it is");
    expect((await srv.api.decision(old.id)).decision.status).toBe("accepted");

    await srv.api.update(p.id, { status: "accepted" });
    expect((await srv.api.decision(old.id)).decision).toMatchObject({ status: "superseded", superseded_by: p.id });
    const hist = await srv.api.revisions(old.id);
    expect(hist.revisions.at(-1)!.note).toBe(`superseded by ${p.id}`);
  });

  it("refuses to accept a proposal whose target was superseded meanwhile", async () => {
    const old = (await srv.api.create({ title: "Tabs" })).decision;
    fake.next = [{ title: "Two-space indent", supersedes: [old.id] }];
    const p = (await srv.api.capture({ source: "notes", text: "we agreed on two spaces" })).proposals[0].decision;
    await srv.api.create({ title: "Four-space indent", supersedes: [old.id] });
    await expect(srv.api.update(p.id, { status: "accepted" })).rejects.toMatchObject({ status: 409 });
    expect((await srv.api.decision(p.id)).decision.status).toBe("proposed");
  });
});

describe("session capture", () => {
  const fake = new FakeExtractor();
  let srv: Awaited<ReturnType<typeof startTestServer>>;
  beforeAll(async () => {
    srv = await startTestServer({ extractor: fake });
    await srv.api.upsertProject({ slug: "web" });
  });
  afterAll(() => srv.close());

  const line = (type: string, content: unknown, extra: object = {}) => JSON.stringify({ type, message: { role: type, content }, ...extra });

  it("keeps only what was said, not tools, thinking or injected context", () => {
    const msgs = parseTranscript(
      [
        line("user", "Should we use JWTs?<system-reminder>ignore me</system-reminder>"),
        line("assistant", [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Sessions are easier to revoke." }]),
        line("assistant", [{ type: "tool_use", id: "t", name: "Bash", input: {} }]),
        line("user", [{ type: "tool_result", tool_use_id: "t", content: "output" }]),
        line("assistant", [{ type: "text", text: "Want me to switch?" }]),
        line("user", "meta", { isMeta: true }),
        line("user", "subagent", { isSidechain: true }),
        "not json",
        JSON.stringify({ type: "summary", summary: "x" }),
        line("user", "Yes, sessions."),
      ].join("\n"),
    );
    expect(msgs).toEqual([
      { role: "user", text: "Should we use JWTs?" },
      { role: "assistant", text: "Sessions are easier to revoke.\nWant me to switch?" },
      { role: "user", text: "Yes, sessions." },
    ]);
  });

  it("sends new turns in batches with context, once each, and backs off when the server has capture off", async () => {
    const { root, session } = linkedRepo(srv.url, srv.token);
    const transcript = join(root, "t.jsonl");
    const turns: string[] = [];
    const say = (...ts: [string, string][]) => {
      for (const [role, text] of ts) turns.push(line(role, role === "user" ? text : [{ type: "text", text }]));
      writeFileSync(transcript, turns.join("\n"));
    };
    say(["user", "Should we use JWTs?"], ["assistant", "Sessions revoke instantly."]);
    expect((await captureSession(session, { transcript, sessionId: "s1" })).status).toBe("waiting");

    fake.next = [{ title: "Sessions over JWTs" }];
    const r = await captureSession(session, { transcript, sessionId: "s1", final: true });
    expect(r.status).toBe("sent");
    expect(r.proposals!.map((d) => d.title)).toEqual(["Sessions over JWTs"]);
    expect(r.proposals![0].projects).toEqual(["web"]);
    expect(fake.calls.at(-1)!.text).toBe("Developer: Should we use JWTs?\n\nAgent: Sessions revoke instantly.");

    expect((await captureSession(session, { transcript, sessionId: "s1", final: true })).status).toBe("nothing");

    say(["user", "Also, the token is sk-ant-api03-abcdefghijklmnopqrstuv"], ["assistant", "Noted."]);
    await captureSession(session, { transcript, sessionId: "s1", final: true });
    const sent = fake.calls.at(-1)!.text;
    expect(sent).toContain("[Earlier in the conversation, already reviewed; for context only]\nDeveloper: Should we use JWTs?");
    expect(sent).toContain("[New since then]\nDeveloper: Also, the token is [redacted]");
    expect(fake.calls.at(-1)!.existing.map((d) => d.title)).toContain("Sessions over JWTs");

    const plain = await startTestServer();
    try {
      const other = linkedRepo(plain.url, plain.token);
      expect((await captureSession(other.session, { transcript, sessionId: "s2", final: true })).status).toBe("disabled");
      expect((await captureSession(other.session, { transcript, sessionId: "s2", final: true })).status).toBe("disabled");
    } finally {
      await plain.close();
    }
  });
});

describe("git history", () => {
  it("reads commits oldest first with their files, and batches them", () => {
    const root = tmp("de-git-");
    sh(root, "init", "-q", "-b", "main");
    sh(root, "config", "user.name", "Test");
    sh(root, "config", "user.email", "t@example.com");
    sh(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, "a.txt"), "a");
    sh(root, "add", ".");
    sh(root, "commit", "-q", "-m", "First", "-m", "Chose Postgres over Mongo: we need transactions.");
    writeFileSync(join(root, "b.txt"), "b");
    sh(root, "add", ".");
    sh(root, "commit", "-q", "-m", "Second");
    const commits = readCommits(root);
    expect(commits.map((c) => c.subject)).toEqual(["First", "Second"]);
    expect(commits[0]).toMatchObject({ body: "Chose Postgres over Mongo: we need transactions.", files: ["a.txt"], author: "Test" });
    expect(renderCommits(commits)).toContain("Chose Postgres over Mongo");
    expect(readCommits(root, { limit: 1 }).map((c) => c.subject)).toEqual(["Second"]);
    expect(batchCommits(commits, 10)).toHaveLength(2);
    expect(batchCommits(commits, 100_000)).toHaveLength(1);
  });
});

describe("Claude extractor", () => {
  it("asks for structured output and turns it into proposals", async () => {
    const { ClaudeExtractor } = await import("../src/server/extract.js");
    let params: any;
    const reply = (stop_reason: string, parsed_output: unknown) => ({
      beta: { messages: { stream: (p: any) => ((params = p), { finalMessage: async () => ({ stop_reason, parsed_output }) }) } },
    });
    const ex = new ClaudeExtractor({ client: reply("end_turn", { decisions: [raw()] }) as any });
    const out = await ex.extract({ source: "git", text: "commit abc\nSwitch to pnpm", existing: [decision("DEC-001", { title: "Sessions" })] });
    expect(out).toEqual([expect.objectContaining({ title: "Use pnpm", why: "Faster installs", evidence: "let's go with pnpm" })]);
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.output_config.effort).toBe("high");
    expect(params.output_config.format).toBeDefined();
    expect(JSON.stringify(params.messages)).toContain("DEC-001 [accepted] Sessions");
    expect(JSON.stringify(params.messages)).toContain("commit history");

    expect(await new ClaudeExtractor({ client: reply("refusal", null) as any }).extract({ source: "notes", text: "x", existing: [] })).toEqual([]);
    await expect(new ClaudeExtractor({ client: reply("max_tokens", null) as any }).extract({ source: "notes", text: "x", existing: [] })).rejects.toThrow(/cut off/);
    await expect(ex.extract({ source: "notes", text: "x".repeat(MAX_CAPTURE_CHARS + 1), existing: [] })).rejects.toThrow(RangeError);
  });
});

describe("extraction contract", () => {
  it("asks for bare JSON against the existing decisions, and reads replies leniently", () => {
    const p = extractionPrompt([decision("DEC-007", { title: "Sessions over JWTs" })], "the notes below");
    expect(p).toContain("DEC-007 [accepted] Sessions over JWTs");
    expect(p).toContain("Read the notes below");
    expect(p).toMatch(/Reply with only a JSON object/);
    expect(parseJsonReply('Sure.\n```json\n{"decisions": []}\n```')).toEqual({ decisions: [] });
    expect(() => parseJsonReply("I found nothing.")).toThrow(SyntaxError);
    expect(fromLooseOutput({ decisions: [{ title: "Use pnpm" }] }, [])).toEqual([
      expect.objectContaining({ title: "Use pnpm", discipline: "engineering", rules: [], depends_on: [] }),
    ]);
    expect(fromLooseOutput({ nope: true }, [])).toEqual([]);
  });
});

describe("capture on the developer's own Claude", () => {
  let srv: Awaited<ReturnType<typeof startTestServer>>;
  beforeAll(async () => {
    srv = await startTestServer(); // no server-side key
    await srv.api.upsertProject({ slug: "web" });
  });
  afterAll(() => {
    process.env.DE_CAPTURE_LOCAL = "off";
    delete process.env.DE_CLAUDE_BIN;
    return srv.close();
  });

  it("runs claude -p with no tools, outside the repo, with capture off, and records what it finds", async () => {
    const { root, session } = linkedRepo(srv.url, srv.token);
    await srv.api.create({ title: "Postgres for everything" });
    const fake = fakeClaude({ decisions: [{ title: "Sessions over JWTs", why: "instant revocation", evidence: "Yes, sessions." }] });
    process.env.DE_CLAUDE_BIN = fake.bin;
    delete process.env.DE_CAPTURE_LOCAL;

    expect(await chooseExtraction(session)).toBe("claude-code");
    const found = await captureMaterial(session, { source: "notes", text: "We agreed: sessions. token=supersecretvalue", what: "the notes below", via: "claude-code" });
    expect(found.map((d) => [d.title, d.status, d.source, d.projects])).toEqual([["Sessions over JWTs", "proposed", "capture:notes", ["web"]]]);

    const call = fake.call();
    expect(call.args.slice(0, 1)).toEqual(["-p"]);
    expect(call.args).toEqual(expect.arrayContaining(["--tools", "", "--no-session-persistence"]));
    expect(call.args[1]).toContain("Postgres for everything");
    expect(call.input).toContain("We agreed: sessions.");
    expect(call.input).not.toContain("supersecretvalue");
    expect(call.capture).toBe("off");
    expect(call.cwd.startsWith(root)).toBe(false);
  });

  it("serves the Claude Code plugin: claim, prompt, submit", async () => {
    const { root, session } = linkedRepo(srv.url, srv.token);
    const run = (args: string[], input = "") =>
      new Promise<any>((resolve, reject) => {
        const child = execFile("npx", ["tsx", join(__dirname, "../src/cli.ts"), ...args], { cwd: root, env: process.env }, (err, stdout) =>
          err ? reject(err) : resolve(JSON.parse(stdout.trim().split("\n").at(-1)!)),
        );
        child.stdin!.end(input);
      });

    expect(await run(["plugin-capture", "claim", "--session", "p1"])).toMatchObject({ linked: true, project: "web" });
    const transcript = join(root, "t.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }));
    expect((await captureSession(session, { transcript, sessionId: "p1", final: true })).status).toBe("disabled");

    const { prompt } = await run(["plugin-capture", "prompt", "--session", "p1"]);
    expect(prompt).toContain("this conversation between the developer and you");

    const reply = 'Found one.\n```json\n{"decisions":[{"title":"Feature flags via config, not code","why":"ops can flip them","rules":[{"type":"forbid_pattern","pattern":"if \\\\(FLAG_","paths":[],"packages":[],"message":"use config"}]}]}\n```';
    const res = await run(["plugin-capture", "submit", "--session", "p1"], reply);
    expect(res.proposals).toEqual([expect.objectContaining({ title: "Feature flags via config, not code", rules: 1 })]);
    const d = (await srv.api.decision(res.proposals[0].id)).decision;
    expect(d).toMatchObject({ status: "proposed", source: "capture:claude-code", source_ref: "claude-code:p1", projects: ["web"] });

    expect(await run(["decide-proposal", "accept", d.id])).toEqual({ id: d.id, status: "accepted" });
    expect(await run(["plugin-capture", "submit", "--session", "p1"], "no json here")).toHaveProperty("error");
  }, 60_000);
});
