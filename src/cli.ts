#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command, Option } from "commander";
import { importAdrs } from "./adr.js";
import { installClaudeCode, installGitHook, runPreToolUse, sessionStartContext } from "./agent/hooks.js";
import { ApiClient, ApiError, OfflineError } from "./client/api.js";
import { watch } from "./client/cache.js";
import { findProjectRoot, normalizeServer, removeCredentials, resolveContext, saveCredentials, writeLink, LINK_FILE } from "./client/config.js";
import { NotConfiguredError, Session } from "./client/session.js";
import { check, toCheckEvent } from "./core/check.js";
import { DecisionGraph } from "./core/graph.js";
import { toMarkdownFile } from "./core/markdown.js";
import { c, contextMarkdown, decisionMarkdown, describeRule, summaryMarkdown, violationReport } from "./core/render.js";
import { STATUSES, type FileChange, type Rule } from "./core/types.js";
import { ValidationError } from "./core/validate.js";
import { GitError, collectGitChanges, isGitRepo } from "./git.js";
import { VERSION } from "./version.js";

class UsageError extends Error {}

const collect = (v: string, prev: string[] = []) => [...prev, v];
const session = () => Session.open();

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) return readStdin().trim();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function parseRejected(values: string[] = []) {
  return values.map((v) => {
    const i = v.search(/[:—]/);
    return i === -1 ? { option: v.trim() } : { option: v.slice(0, i).trim(), reason: v.slice(i + 1).trim() || undefined };
  });
}

function rulesFromFlags(o: any): Rule[] {
  const rules: Rule[] = [];
  const message = o.message as string | undefined;
  if (o.forbidDep?.length) rules.push({ type: "forbid_dependency", packages: o.forbidDep, message });
  for (const p of o.forbid ?? []) rules.push({ type: "forbid_pattern", pattern: p, message });
  for (const p of o.require ?? []) {
    if (!o.scope?.length) throw new UsageError("--require needs at least one --scope glob");
    rules.push({ type: "require_pattern", pattern: p, paths: o.scope, message });
  }
  if (o.forbidPath?.length) rules.push({ type: "forbid_path", paths: o.forbidPath, message });
  return rules;
}

function gitRemote(root: string): string | undefined {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function defaultProjectSlug(root: string): string {
  const remote = gitRemote(root);
  const fromRemote = remote?.match(/([^/:]+?)(\.git)?$/)?.[1];
  return (fromRemote ?? basename(root)).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

const program = new Command();
program
  .name("de")
  .description("DecisionEngine: capture your team's decisions as you make them, and hold every agent to them.")
  .version(VERSION);

// ------------------------------------------------------------------ service & identity

program
  .command("server")
  .description("run the DecisionEngine service (API, live feed and dashboard)")
  .option("-p, --port <port>", "port", process.env.PORT ?? "4477")
  .option("--host <host>", "interface to bind", process.env.HOST ?? "127.0.0.1")
  .option("--database-url <url>", "Postgres connection string (default: $DATABASE_URL, else embedded Postgres)", process.env.DATABASE_URL)
  .option("--data-dir <dir>", "data directory for embedded Postgres")
  .action(async (o) => {
    const { startServer } = await import("./server/main.js");
    const srv = await startServer({ port: Number(o.port), host: o.host, databaseUrl: o.databaseUrl, dataDir: o.dataDir });
    console.log(`DecisionEngine ${VERSION} listening on ${srv.url}  (${o.databaseUrl ? "Postgres" : "embedded Postgres"})`);
    console.log(srv.capture ? "Automatic capture: on" : c.dim("Automatic capture: off (set ANTHROPIC_API_KEY to turn it on)"));
    const health = await new ApiClient(srv.url).health();
    if (health.setup_required) console.log(`\nFirst run. Create your workspace:\n  de setup ${srv.url} --workspace "Acme" --name "Your Name" --email you@example.com`);
    const shutdown = async () => {
      await srv.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("setup")
  .description("create the workspace and its owner on a fresh server, and sign in")
  .argument("<server-url>")
  .requiredOption("--workspace <name>", "workspace (team or company) name")
  .requiredOption("--name <name>", "your name")
  .requiredOption("--email <email>", "your email")
  .option("--prefix <prefix>", "decision key prefix", "DEC")
  .action(async (url, o) => {
    const server = normalizeServer(url);
    const out = await new ApiClient(server).setup({ workspace: o.workspace, name: o.name, email: o.email, prefix: o.prefix });
    saveCredentials(server, { token: out.token, workspace: out.workspace.name, member: out.member.email });
    console.log(`${c.green("Created")} workspace ${c.bold(out.workspace.name)}; signed in as ${out.member.name} (owner).`);
    console.log(`\nNext, in each repository:  de init --claude`);
    console.log(`Invite teammates:          de invite --name "..." --email ...`);
  });

program
  .command("login")
  .description("sign in to a DecisionEngine server with an API token")
  .argument("[server-url]", "defaults to the server in this repo's link file")
  .option("--token <token>", "API token (or pipe it on stdin)")
  .action(async (url, o) => {
    const server = normalizeServer(url ?? resolveContext().server ?? "");
    if (!server) throw new UsageError("Which server? Usage: de login <server-url>");
    const token = o.token ?? process.env.DE_TOKEN ?? (await prompt(`API token for ${server}: `));
    if (!token) throw new UsageError("A token is required. Ask a workspace admin to run `de invite`.");
    const me = await new ApiClient(server, token).me();
    saveCredentials(server, { token, workspace: me.workspace.name, member: me.member.email });
    console.log(`Signed in to ${c.bold(me.workspace.name)} as ${me.member.name} (${me.member.role}).`);
  });

program
  .command("logout")
  .description("revoke this machine's token and forget it")
  .action(async () => {
    const s = session();
    await s.api.request("DELETE", "/v1/tokens/current").catch(() => {});
    removeCredentials(s.ctx.server);
    console.log(`Signed out of ${s.ctx.server}.`);
  });

program
  .command("whoami")
  .description("show the signed-in member, workspace and linked project")
  .action(async () => {
    const s = session();
    const me = await s.api.me();
    console.log(`${me.member.name} <${me.member.email}> · ${me.member.role} of ${c.bold(me.workspace.name)} on ${s.ctx.server}`);
    console.log(s.ctx.project ? `Linked project: ${s.ctx.project}` : c.dim("This directory is not linked to a project (run `de init`)."));
  });

program
  .command("invite")
  .description("add a teammate and print their API token (owners and admins)")
  .requiredOption("--name <name>")
  .requiredOption("--email <email>")
  .addOption(new Option("--role <role>").choices(["member", "admin", "owner"]).default("member"))
  .action(async (o) => {
    const s = session();
    const { member, token } = await s.api.invite({ name: o.name, email: o.email, role: o.role });
    console.log(`Invited ${member.name} as ${member.role}. Send them this command (the token is shown once):\n`);
    console.log(`  de login ${s.ctx.server} --token ${token}`);
  });

program
  .command("members")
  .description("list workspace members")
  .action(async () => {
    for (const m of (await session().api.members()).members) console.log(`${m.name} <${m.email}>  ${c.dim(m.role)}`);
  });

// ------------------------------------------------------------------ repository setup

program
  .command("init")
  .description("link this repository to a project and wire up agent hooks")
  .option("--project <slug>", "project slug (default: from the git remote or directory name)")
  .option("--claude", "install Claude Code hooks and MCP config")
  .option("--git-hook", "install a git pre-commit check")
  .option("--no-capture", "don't send Claude Code sessions for decision capture")
  .option("--bin <command>", "command used to invoke DecisionEngine from hooks", "de")
  .action(async (o) => {
    const s = session();
    const root = findProjectRoot();
    const { project } = await s.api.upsertProject({ slug: o.project ?? defaultProjectSlug(root), repo_url: gitRemote(root) });
    writeLink(root, { server: s.ctx.server, project: project.slug });
    console.log(`Linked ${relative(process.cwd(), join(root, LINK_FILE)) || LINK_FILE} to project ${c.bold(project.slug)} on ${s.ctx.server}`);
    if (o.claude) for (const line of installClaudeCode(root, o.bin, { capture: o.capture })) console.log(`Installed ${line}`);
    if (o.gitHook) console.log(`Installed ${installGitHook(root, o.bin)}`);
    console.log(c.dim(`\nCommit ${LINK_FILE}${o.claude ? ", .claude/settings.json and .mcp.json" : ""} so teammates' agents use the same decisions.`));
  });

program
  .command("install")
  .description("wire DecisionEngine into an agent or workflow")
  .addArgument(new Command().createArgument("<target>", "claude-code | git-hook").choices(["claude-code", "git-hook"]))
  .option("--no-capture", "don't send Claude Code sessions for decision capture")
  .option("--bin <command>", "command used to invoke DecisionEngine from hooks", "de")
  .action((target, o) => {
    const root = findProjectRoot();
    if (target === "claude-code") for (const line of installClaudeCode(root, o.bin, { capture: o.capture })) console.log(`Installed ${line}`);
    else console.log(`Installed ${installGitHook(root, o.bin)}`);
  });

// ------------------------------------------------------------------ decisions

const decisionOptions = (cmd: Command) =>
  cmd
    .option("-w, --why <text>", "why this was chosen")
    .option("-r, --reject <option: reason>", "a rejected alternative (repeatable)", collect)
    .option("-t, --tag <tag>", "tag (repeatable)", collect)
    .option("-s, --scope <glob>", "path glob this governs (repeatable; omit for everywhere)", collect)
    .option("--discipline <name>", "engineering, design, product, business, operations");

decisionOptions(
  program
    .command("new")
    .alias("decide")
    .description("record a decision and share it with the team")
    .argument("<title>", 'the decision, e.g. "Sessions over JWTs"'),
)
  .option("-d, --depends <id>", "decision this builds on (repeatable)", collect)
  .option("--supersedes <id>", "decision this replaces (repeatable)", collect)
  .option("--project-only", "apply only to this repository's project, not the whole workspace")
  .option("--forbid-dep <package>", "rule: forbid adding this dependency (repeatable)", collect)
  .option("--forbid <regex>", "rule: forbid this pattern in scoped files (repeatable)", collect)
  .option("--require <regex>", "rule: scoped files must contain this pattern (repeatable; needs --scope)", collect)
  .option("--forbid-path <glob>", "rule: forbid creating or changing these paths (repeatable)", collect)
  .option("--message <text>", "message shown when a rule is violated")
  .option("--body <markdown>", "longer notes: context, consequences")
  .option("--ref <url>", "link to where this was decided (thread, doc, session)")
  .addOption(new Option("--status <status>", "initial status").choices(["proposed", "accepted"]).default("accepted"))
  .option("--json", "print the created decision as JSON")
  .action(async (title, o) => {
    const s = session();
    if (o.projectOnly && !s.ctx.project) throw new UsageError("--project-only needs a linked project (run `de init`).");
    const { decision: d, warnings } = await s.api.create({
      title,
      why: o.why,
      rejected: parseRejected(o.reject),
      tags: o.tag,
      scope: o.scope,
      projects: o.projectOnly ? [s.ctx.project] : [],
      depends_on: o.depends,
      supersedes: o.supersedes,
      discipline: o.discipline,
      rules: rulesFromFlags(o),
      body: o.body,
      status: o.status,
      source: "cli",
      source_ref: o.ref,
    });
    await s.cache.refresh().catch(() => {});
    if (o.json) return console.log(JSON.stringify(d, null, 2));
    console.log(`${c.green("Recorded")} ${c.bold(d.id)} ${d.title}  ${c.dim("shared with your team")}`);
    if (d.supersedes.length) console.log(c.dim(`Superseded ${d.supersedes.join(", ")}`));
    if (d.rules.length) console.log(c.dim(`Enforced: ${d.rules.map(describeRule).join("; ")}`));
    for (const w of warnings) console.log(c.yellow(`warning: ${w}`));
    if (!d.why) console.log(c.yellow("Tip: add --why so future readers (and agents) know the reasoning."));
  });

decisionOptions(
  program
    .command("supersede")
    .description("replace a decision with a new one")
    .argument("<id>", "decision being replaced")
    .argument("<title>", "the new decision"),
).action(async (id, title, o) => {
  const s = session();
  const { decision: old } = await s.api.decision(id);
  const { decision: d, warnings } = await s.api.create({
    title,
    why: o.why,
    rejected: o.reject?.length ? parseRejected(o.reject) : [{ option: old.title, reason: "superseded" }],
    tags: o.tag ?? old.tags,
    scope: o.scope ?? old.scope,
    projects: old.projects,
    depends_on: old.depends_on,
    supersedes: [old.id],
    discipline: o.discipline ?? old.discipline,
    source: "cli",
  });
  await s.cache.refresh().catch(() => {});
  console.log(`${c.green("Recorded")} ${c.bold(d.id)} ${d.title}; ${old.id} is now superseded.`);
  if (old.rules.length) console.log(c.dim(`${old.id}'s rules are no longer enforced. Add rules with \`de edit ${d.id} --add-rule\` if the new decision needs them.`));
  for (const w of warnings) console.log(c.yellow(`warning: ${w}`));
});

decisionOptions(program.command("edit").description("change a decision (every edit is kept in its history)").argument("<id>"))
  .option("--title <title>")
  .option("--add-rule <json>", "append a rule given as JSON (repeatable)", collect)
  .option("--clear-rules", "remove all rules")
  .option("--note <text>", "why it changed")
  .action(async (id, o) => {
    const s = session();
    const patch: Record<string, unknown> = { note: o.note };
    if (o.title) patch.title = o.title;
    if (o.why) patch.why = o.why;
    if (o.tag) patch.tags = o.tag;
    if (o.scope) patch.scope = o.scope;
    if (o.discipline) patch.discipline = o.discipline;
    if (o.reject) patch.rejected = parseRejected(o.reject);
    if (o.clearRules || o.addRule) {
      const { decision } = await s.api.decision(id);
      let added: Rule[];
      try {
        added = (o.addRule ?? []).map((j: string) => JSON.parse(j));
      } catch {
        throw new UsageError(`--add-rule expects JSON, e.g. '{"type":"forbid_dependency","packages":["moment"]}'`);
      }
      patch.rules = [...(o.clearRules ? [] : decision.rules), ...added];
    }
    const { decision } = await s.api.update(id, patch);
    await s.cache.refresh().catch(() => {});
    console.log(`Updated ${decision.id} (revision ${decision.revision}).`);
  });

for (const [name, status, desc] of [
  ["accept", "accepted", "mark a proposed decision as accepted"],
  ["deprecate", "deprecated", "retire a decision without replacing it"],
  ["propose", "proposed", "move a decision back to proposed"],
] as const) {
  program
    .command(name)
    .description(desc)
    .argument("<id>")
    .option("--note <text>", "why")
    .action(async (id, o) => {
      const s = session();
      const { decision } = await s.api.update(id, { status, note: o.note });
      await s.cache.refresh().catch(() => {});
      console.log(`${decision.id} is now ${decision.status}.`);
    });
}

program
  .command("list")
  .alias("ls")
  .description("list decisions")
  .addOption(new Option("--status <status>").choices([...STATUSES, "all", "active"]).default("active"))
  .option("-t, --tag <tag>")
  .option("--all-projects", "include decisions limited to other projects")
  .option("--json")
  .action(async (o) => {
    const s = session();
    const [{ decisions }, st] = await Promise.all([s.api.decisions(), s.api.stats(7)]);
    const ds = (o.allProjects ? decisions : s.forProject(decisions)).filter((d) => {
      if (o.status === "active" && !["accepted", "proposed"].includes(d.status)) return false;
      if (!["active", "all"].includes(o.status) && d.status !== o.status) return false;
      return !o.tag || d.tags.includes(o.tag);
    });
    if (o.json) return console.log(JSON.stringify(ds, null, 2));
    if (!ds.length) return console.log("No decisions.");
    for (const d of ds) {
      const stat = st.stats[d.id];
      const flags = [
        d.status !== "accepted" ? c.yellow(d.status) : "",
        d.rules.length && d.status === "accepted" ? c.cyan("enforced") : "",
        stat?.checks ? c.dim(`checked ${stat.checks}x/wk`) : "",
        d.author ? c.dim(d.author) : "",
      ].filter(Boolean);
      console.log(`${c.bold(d.id)}  ${d.title}${flags.length ? "  " + flags.join(" ") : ""}`);
    }
  });

program
  .command("show")
  .description("show a decision with its upstream and downstream links")
  .argument("<id>")
  .option("--history", "include every revision")
  .option("--json")
  .action(async (id, o) => {
    const s = session();
    const [detail, { decisions }, st] = await Promise.all([s.api.decision(id), s.api.decisions(), s.api.stats(7)]);
    const revisions = o.history ? (await s.api.revisions(id)).revisions : undefined;
    if (o.json) return console.log(JSON.stringify({ ...detail, revisions }, null, 2));
    const d = detail.decision;
    console.log(decisionMarkdown(d, { graph: new DecisionGraph(decisions), full: true }));
    const stat = st.stats[d.id];
    if (stat) console.log(c.dim(`\nChecked ${stat.checks} time(s) this week; ${stat.violations} violation(s) caught.`));
    if (revisions) {
      console.log(`\n${c.bold("History")}`);
      for (const r of revisions) console.log(`  r${r.revision}  ${r.created_at.slice(0, 16).replace("T", " ")}  ${r.author ?? ""}  ${r.note ?? ""}`);
    }
  });

program
  .command("context")
  .description("print the decisions governing some paths, formatted for an agent's context")
  .argument("[paths...]", "files the agent is about to touch")
  .option("--summary", "one line per decision")
  .action(async (paths: string[], o) => {
    const s = session();
    const { decisions } = await s.cache.get({ maxAgeMs: 0, timeoutMs: 5_000 });
    const mine = s.forProject(decisions);
    const rel = paths.map((p) => relative(s.ctx.root, resolve(p)).replace(/\\/g, "/"));
    let ds = mine.filter((d) => d.status === "accepted");
    if (rel.length) {
      const g = new DecisionGraph(mine);
      const ids = new Set(rel.flatMap((p) => g.governing(p).map((d) => d.id)));
      ds = ds.filter((d) => ids.has(d.id));
    }
    console.log(o.summary ? summaryMarkdown(ds) : contextMarkdown(ds, rel, new DecisionGraph(decisions)));
  });

// ------------------------------------------------------------------ enforcement

program
  .command("check")
  .description("check changes against settled decisions (exit 1 on violations)")
  .argument("[paths...]", "check these files in full instead of the git diff")
  .option("--staged", "only staged changes (pre-commit)")
  .option("--base <ref>", "changes since the merge-base with <ref> (CI / pull requests)")
  .option("--json", "machine-readable output")
  .action(async (paths: string[], o) => {
    const s = session();
    let changes: FileChange[];
    if (paths.length) {
      changes = paths.map((p) => ({ path: relative(s.ctx.root, resolve(p)).replace(/\\/g, "/"), content: readFileSync(p, "utf8") }));
    } else {
      if (!isGitRepo(s.ctx.root)) throw new UsageError("Not a git repository; pass file paths to check.");
      changes = collectGitChanges(s.ctx.root, { staged: o.staged, base: o.base });
    }
    // CI and pre-commit enforce the current truth, so this path requires the service.
    const { decisions } = await s.cache.refresh();
    const result = check(s.forProject(decisions), changes);
    await s.cache.report(toCheckEvent(result, changes, { source: process.env.CI ? "ci" : "cli", blocked: true, project: s.ctx.project }), 5_000);
    if (o.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(violationReport(result, new DecisionGraph(decisions)));
      if (result.touched.length && !result.violations.length) console.log(c.dim(`Decisions in the blast radius: ${result.touched.join(", ")}`));
    }
    if (result.violations.length) process.exitCode = 1;
  });

program
  .command("lint")
  .description("check the decision graph for broken links, cycles, stale dependencies and conflicting rules")
  .option("--strict", "exit 1 on warnings too")
  .action(async (o) => {
    const { issues } = await session().api.lint();
    if (!issues.length) return console.log(c.green("No issues."));
    for (const i of issues) {
      const tag = i.level === "error" ? c.red("error") : i.level === "warning" ? c.yellow("warn ") : c.dim("info ");
      console.log(`${tag} ${c.bold(i.id)} ${i.message}`);
    }
    if (issues.some((i) => i.level === "error" || (o.strict && i.level === "warning"))) process.exitCode = 1;
  });

program
  .command("digest")
  .description("what the team decided, reversed and enforced recently")
  .option("--days <n>", "look-back window", "7")
  .action(async (o) => console.log((await session().api.digest(Number(o.days))).markdown));

program
  .command("watch")
  .description("follow the team's decisions live (also keeps the local enforcement cache current)")
  .action(async () => {
    const s = session();
    const snap = await s.cache.refresh();
    console.log(c.dim(`Watching ${s.ctx.server} (${snap.decisions.length} decisions). Ctrl+C to stop.`));
    const stop = watch(s.cache, (e) => {
      const time = new Date().toLocaleTimeString();
      const d = e.data ?? {};
      if (e.type === "decision.created") console.log(`${c.dim(time)} ${c.green("new")}        ${c.bold(d.decision_key)} ${d.payload?.title ?? ""} ${c.dim(d.actor ?? "")}`);
      else if (e.type === "decision.superseded") console.log(`${c.dim(time)} ${c.yellow("superseded")} ${c.bold(d.decision_key)} by ${d.payload?.by}`);
      else if (e.type === "decision.updated") console.log(`${c.dim(time)} ${c.cyan("updated")}    ${c.bold(d.decision_key)} ${c.dim((d.payload?.fields ?? []).join(", "))}`);
      else if (e.type === "check.violation") {
        const v = d.payload?.violations ?? [];
        console.log(`${c.dim(time)} ${c.red(d.payload?.blocked ? "blocked" : "violation")}    ${v.map((x: any) => x.id).join(", ")} in ${d.payload?.project ?? "?"} ${c.dim(`${d.actor ?? ""} ${d.payload?.agent ?? d.payload?.source ?? ""}`)}`);
      }
    });
    process.on("SIGINT", () => {
      stop();
      process.exit(0);
    });
  });

// ------------------------------------------------------------------ data in / out

program
  .command("import-adr")
  .description("import existing Architecture Decision Records (Nygard or MADR format)")
  .argument("<dir>", "directory of ADR markdown files, e.g. docs/adr")
  .action(async (dir) => {
    const created = await importAdrs(session().api, dir);
    console.log(`Imported ${created.length} decision(s).`);
    for (const d of created) console.log(`  ${d.id} ${d.title}${d.status !== "accepted" ? c.dim(` (${d.status})`) : ""}`);
  });

program
  .command("capture")
  .description("find decisions in commit history or notes and record them as proposals to review")
  .option("--from-git", "read this repository's commit history")
  .option("--since <date>", "with --from-git: only commits after this date (e.g. 2025-01-01, '6 months ago')")
  .option("--limit <n>", "with --from-git: only the most recent n commits")
  .option("--range <range>", "with --from-git: a revision range, e.g. v1.0..main")
  .option("--notes <file>", "read notes, a thread or a document ('-' for stdin)")
  .option("--ref <ref>", "where the material came from (a URL or name), kept on each proposal")
  .option("--yes", "skip the confirmation prompt")
  .action(async (o) => {
    if (!o.fromGit === !o.notes) throw new UsageError("Pass exactly one of --from-git or --notes <file>.");
    const s = session();
    const status = await s.api.captureStatus();
    if (!status.enabled) throw new UsageError(`Capture is not enabled on ${s.ctx.server}. The server needs ANTHROPIC_API_KEY set.`);
    const { readCommits, batchCommits, renderCommits } = await import("./client/capture.js");
    const { redactSecrets, chunkText } = await import("./core/capture.js");
    const requests: { text: string; ref?: string; label: string }[] = [];
    let source: "git" | "notes";
    if (o.fromGit) {
      source = "git";
      const root = findProjectRoot();
      if (!isGitRepo(root)) throw new UsageError("Not a git repository.");
      let commits;
      try {
        commits = readCommits(root, { since: o.since, limit: o.limit ? Number(o.limit) : undefined, range: o.range });
      } catch (e) {
        throw new GitError(`git log failed: ${(e as Error).message.split("\n")[0]}`);
      }
      if (!commits.length) return console.log("No commits to read.");
      // Modest batches keep extraction careful; each sees the proposals from the ones before it.
      for (const b of batchCommits(commits, 120_000))
        requests.push({ text: redactSecrets(renderCommits(b)), ref: o.ref ?? `git:${b[0].hash.slice(0, 10)}..${b[b.length - 1].hash.slice(0, 10)}`, label: `${b.length} commits (${b[0].date} to ${b[b.length - 1].date})` });
      console.log(`Read ${commits.length} commits; ${requests.length} batch(es) to analyse.`);
    } else {
      source = "notes";
      const text = o.notes === "-" ? readStdin() : readFileSync(o.notes, "utf8");
      if (!text.trim()) return console.log("Nothing to read.");
      const parts = chunkText(redactSecrets(text), 120_000);
      parts.forEach((t, i) => requests.push({ text: t, ref: o.ref ?? (o.notes === "-" ? undefined : basename(o.notes)), label: parts.length > 1 ? `part ${i + 1}/${parts.length}` : "notes" }));
    }
    const chars = requests.reduce((n, r) => n + r.text.length, 0);
    if (!o.yes && process.stdin.isTTY) {
      const ok = await prompt(`Send ${chars.toLocaleString()} characters to ${s.ctx.server} for analysis? [y/N] `);
      if (!/^y/i.test(ok)) return console.log("Cancelled.");
    }
    let total = 0;
    for (const r of requests) {
      process.stdout.write(c.dim(`Analysing ${r.label}… `));
      const res = await s.api.capture({ source, text: r.text, source_ref: r.ref, project: s.ctx.project });
      console.log(c.dim(`${res.proposals.length} proposal(s)`));
      for (const { decision: d } of res.proposals) console.log(`  ${c.yellow(d.id)} ${d.title}`);
      total += res.proposals.length;
    }
    console.log(total ? `\n${total} proposal(s) recorded. Review them in the dashboard (\`de ui\`) or with \`de list --status proposed\`, then \`de accept <id>\`.` : "\nNo settled decisions found.");
  });

program
  .command("capture-session", { hidden: true })
  .description("send the unsent part of a Claude Code session for capture (run by the Stop/SessionEnd hooks)")
  .requiredOption("--transcript <path>")
  .requiredOption("--session <id>")
  .option("--final", "send whatever is new, however little")
  .action(async (o) => {
    // Runs detached from the agent; never surfaces errors to it.
    try {
      const s = Session.tryOpen();
      if (!s?.ctx.linked) return;
      const { captureSession } = await import("./client/capture.js");
      await captureSession(s, { transcript: o.transcript, sessionId: o.session, final: !!o.final });
    } catch {
      // Unsent turns stay unsent and go with the next capture.
    }
  });

program
  .command("export")
  .description("export every decision (you own your data)")
  .addOption(new Option("--format <format>").choices(["markdown", "json"]).default("markdown"))
  .option("-o, --out <path>", "directory for markdown, file for json", "decisions-export")
  .option("--history", "include revision history (json only)")
  .action(async (o) => {
    const s = session();
    const { decisions } = await s.api.decisions();
    if (o.format === "json") {
      const out = o.history ? await Promise.all(decisions.map(async (d) => ({ ...d, revisions: (await s.api.revisions(d.id)).revisions }))) : decisions;
      const file = o.out.endsWith(".json") ? o.out : `${o.out}.json`;
      writeFileSync(file, JSON.stringify({ exported_at: new Date().toISOString(), server: s.ctx.server, decisions: out }, null, 2) + "\n");
      return console.log(`Wrote ${decisions.length} decision(s) to ${file}`);
    }
    mkdirSync(o.out, { recursive: true });
    for (const d of decisions) {
      const f = toMarkdownFile(d);
      writeFileSync(join(o.out, f.name), f.content);
    }
    console.log(`Wrote ${decisions.length} decision(s) to ${o.out}/`);
  });

program
  .command("ui")
  .description("open the team dashboard")
  .option("--print", "print the URL instead of opening a browser")
  .action(async (o) => {
    const s = session();
    const url = `${s.ctx.server}/#token=${encodeURIComponent(s.ctx.token)}`;
    if (o.print) return console.log(url);
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    try {
      execFileSync(opener, [url], { stdio: "ignore" });
      console.log(`Opened ${s.ctx.server}`);
    } catch {
      console.log(url);
    }
  });

// ------------------------------------------------------------------ agent entry points

program
  .command("hook")
  .description("entry point for agent hooks (reads the hook payload on stdin)")
  .addArgument(new Command().createArgument("<event>").choices(["pre-tool-use", "session-start", "stop", "session-end"]))
  .action(async (event) => {
    // Fail open: a problem inside DecisionEngine must never block an agent. Only a real violation does.
    try {
      let input: any = {};
      try {
        input = JSON.parse(readStdin() || "{}");
      } catch {
        input = {};
      }
      const s = Session.tryOpen(input.cwd);
      if (!s?.ctx.linked) return; // repository not linked to DecisionEngine
      if (event === "session-start") {
        process.stdout.write(await sessionStartContext(s));
        return;
      }
      if (event === "stop" || event === "session-end") {
        const { spawnSessionCapture } = await import("./client/capture.js");
        spawnSessionCapture(input, event === "session-end");
        return;
      }
      const { exitCode, stderr } = await runPreToolUse(s, input);
      if (stderr) process.stderr.write(stderr + "\n");
      process.exitCode = exitCode;
    } catch (e) {
      process.stderr.write(`DecisionEngine hook error (not blocking): ${(e as Error).message}\n`);
      process.exitCode = 0;
    }
  });

program
  .command("mcp")
  .description("run the MCP server on stdio (Claude Code, Cursor and other MCP clients)")
  .action(async () => {
    const { serveStdio } = await import("./agent/mcp.js");
    await serveStdio(session());
  });

program.parseAsync().catch((e) => {
  if (e instanceof NotConfiguredError || e instanceof UsageError || e instanceof GitError || e instanceof ValidationError || e instanceof OfflineError) {
    console.error(c.red(e.message));
    process.exit(2);
  }
  if (e instanceof ApiError) {
    console.error(c.red(e.status === 401 ? `${e.message}. Run \`de login\`.` : e.message));
    process.exit(2);
  }
  throw e;
});
