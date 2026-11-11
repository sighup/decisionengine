import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { watch } from "../client/cache.js";
import type { Session } from "../client/session.js";
import { check, toCheckEvent } from "../core/check.js";
import { DecisionGraph } from "../core/graph.js";
import { contextMarkdown, decisionMarkdown, violationReport } from "../core/render.js";
import { STATUSES, type FileChange } from "../core/types.js";
import { collectGitChanges, isGitRepo } from "../git.js";
import { VERSION } from "../version.js";
import { addedLines } from "./hooks.js";

const INSTRUCTIONS = `DecisionEngine holds your team's settled decisions: what was chosen, why, and what was rejected. Decisions are shared live across everyone's agents.
- Before changing code in an area, call decisions_for_paths with the files you will touch, and follow what comes back.
- When the user settles a meaningful choice between alternatives, call record_decision with the rejected options and the reasoning. Ask before recording if you are not sure the user considers it settled.
- Never work around a decision. If a task requires breaking one, tell the user which decision blocks it and ask whether to supersede it (record_decision with supersedes).
- Before finishing a task, call check_working_tree to confirm nothing you changed breaks a decision.`;

const ruleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("forbid_pattern"), pattern: z.string(), flags: z.string().optional(), paths: z.array(z.string()).optional(), message: z.string().optional() }),
  z.object({ type: z.literal("require_pattern"), pattern: z.string(), flags: z.string().optional(), paths: z.array(z.string()).min(1), message: z.string().optional() }),
  z.object({ type: z.literal("forbid_dependency"), packages: z.array(z.string()).min(1), message: z.string().optional() }),
  z.object({ type: z.literal("forbid_path"), paths: z.array(z.string()).min(1), message: z.string().optional() }),
]);

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });
const guard =
  <A,>(fn: (a: A) => Promise<ReturnType<typeof text>>) =>
  async (a: A) => {
    try {
      return await fn(a);
    } catch (e) {
      return fail((e as Error).message);
    }
  };

export function createMcpServer(session: Session): McpServer {
  const server = new McpServer({ name: "decisionengine", version: VERSION }, { instructions: INSTRUCTIONS });
  /** Live from the service when reachable; the synced snapshot otherwise. */
  const decisions = async () => (await session.cache.get({ maxAgeMs: 5_000, timeoutMs: 3_000 })).decisions;
  const project = session.ctx.project;

  const runCheck = async (changes: FileChange[]) => {
    const all = await decisions();
    const result = check(session.forProject(all), changes);
    if (result.filesChecked) await session.cache.report(toCheckEvent(result, changes, { source: "mcp", blocked: false, project }));
    const touched = result.touched.length ? `\n\nDecisions in the blast radius of this change: ${result.touched.join(", ")}` : "";
    return text(violationReport(result, new DecisionGraph(all), true) + touched);
  };

  server.registerTool(
    "decisions_for_paths",
    {
      title: "Decisions governing files",
      description: "Return the accepted decisions that govern the given file paths (scoped decisions whose globs match, plus project-wide ones). Call this before editing.",
      inputSchema: { paths: z.array(z.string()).describe("Repository-relative file paths") },
    },
    guard(async ({ paths }) => {
      const all = await decisions();
      const g = new DecisionGraph(session.forProject(all));
      const ids = new Set(paths.flatMap((p) => g.governing(p).map((d) => d.id)));
      return text(contextMarkdown(all.filter((d) => ids.has(d.id)), paths, new DecisionGraph(all)));
    }),
  );

  server.registerTool(
    "list_decisions",
    {
      title: "List decisions",
      description: "List the team's decisions, optionally filtered by status, tag, or a text query over title, rationale and rejected options.",
      inputSchema: { status: z.enum(STATUSES).optional(), tag: z.string().optional(), query: z.string().optional() },
    },
    guard(async ({ status, tag, query }) => {
      const q = query?.toLowerCase();
      const ds = (await decisions()).filter((d) => {
        if (status && d.status !== status) return false;
        if (tag && !d.tags.includes(tag)) return false;
        if (q) {
          const hay = [d.title, d.why, d.body, ...d.rejected.map((r) => `${r.option} ${r.reason ?? ""}`), ...d.tags].join(" ").toLowerCase();
          if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
        }
        return true;
      });
      if (!ds.length) return text("No matching decisions.");
      return text(ds.map((d) => `- ${d.id} [${d.status}] ${d.title}${d.why ? ` — ${d.why}` : ""}`).join("\n"));
    }),
  );

  server.registerTool(
    "get_decision",
    {
      title: "Get decision",
      description: "Full record for one decision: rationale, rejected options, rules, what it builds on, what depends on it, and how often it has been enforced this week.",
      inputSchema: { id: z.string() },
    },
    guard(async ({ id }) => {
      const [{ decision }, all, st] = await Promise.all([session.api.decision(id), decisions(), session.api.stats(7).catch(() => undefined)]);
      const s = st?.stats[decision.id];
      const extra = s ? `\n\nChecked ${s.checks} time(s) in the last 7 days; ${s.violations} violation(s) caught.` : "";
      return text(decisionMarkdown(decision, { graph: new DecisionGraph(all), full: true }) + extra);
    }),
  );

  server.registerTool(
    "record_decision",
    {
      title: "Record decision",
      description:
        "Record a settled decision; it is broadcast to every teammate's agents immediately. Include the rejected alternatives and the reasoning. Add rules only when the decision can be checked mechanically (e.g. a forbidden library or pattern). Use supersedes to replace an earlier decision.",
      inputSchema: {
        title: z.string().describe("The decision as a short imperative or 'X over Y' statement"),
        why: z.string().describe("Why this was chosen, in one or two sentences"),
        rejected: z.array(z.object({ option: z.string(), reason: z.string().optional() })).optional(),
        tags: z.array(z.string()).optional(),
        discipline: z.string().optional().describe("engineering, design, product, business, operations"),
        scope: z.array(z.string()).optional().describe("Path globs this governs; omit for everywhere"),
        project_only: z.boolean().optional().describe("Limit to the current project instead of the whole workspace"),
        depends_on: z.array(z.string()).optional().describe("IDs of decisions this builds on"),
        supersedes: z.array(z.string()).optional().describe("IDs of decisions this replaces"),
        rules: z.array(ruleSchema).optional(),
        status: z.enum(["proposed", "accepted"]).optional(),
        body: z.string().optional().describe("Optional longer markdown: context, consequences"),
      },
    },
    guard(async ({ project_only, ...args }) => {
      const { decision, warnings } = await session.api.create({ ...args, projects: project_only && project ? [project] : [], source: "mcp" });
      await session.cache.refresh().catch(() => {});
      const warn = warnings.length ? `\n\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}` : "";
      return text(`Recorded ${decision.id}: ${decision.title}. It is now shared with the team.${warn}`);
    }),
  );

  server.registerTool(
    "check_change",
    {
      title: "Check a proposed change",
      description: "Check proposed file contents against settled decisions before writing them. Returns violations with the rationale behind each decision.",
      inputSchema: { files: z.array(z.object({ path: z.string(), content: z.string() })).min(1) },
    },
    guard(async ({ files }) =>
      runCheck(
        files.map((f) => {
          const abs = join(session.ctx.root, f.path);
          const prev = existsSync(abs) ? readFileSync(abs, "utf8") : "";
          return { path: f.path, content: f.content, addedLines: addedLines(prev, f.content) };
        }),
      ),
    ),
  );

  server.registerTool(
    "check_working_tree",
    {
      title: "Check uncommitted changes",
      description: "Check all uncommitted changes (or the diff against a base ref) against settled decisions.",
      inputSchema: { base: z.string().optional().describe("Compare against the merge-base with this ref, e.g. origin/main") },
    },
    guard(async ({ base }) => {
      if (!isGitRepo(session.ctx.root)) return fail("Not a git repository.");
      return runCheck(collectGitChanges(session.ctx.root, { base }));
    }),
  );

  server.registerTool(
    "decision_digest",
    {
      title: "Decision digest",
      description: "What the team decided, reversed and enforced recently. Useful in place of a status meeting.",
      inputSchema: { days: z.number().int().positive().default(7) },
    },
    guard(async ({ days }) => text((await session.api.digest(days)).markdown)),
  );

  return server;
}

export async function serveStdio(session: Session): Promise<void> {
  const server = createMcpServer(session);
  // Keep the shared snapshot live so this session's hooks see teammates' decisions within seconds.
  const stop = watch(session.cache);
  process.on("SIGTERM", stop);
  process.stdin.on("close", stop);
  await server.connect(new StdioServerTransport());
}
