import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { check, toCheckEvent } from "../core/check.js";
import { DecisionGraph } from "../core/graph.js";
import { summaryMarkdown, violationReport } from "../core/render.js";
import type { FileChange } from "../core/types.js";
import type { Session } from "../client/session.js";

/** Lines present in `next` that were not in `prev` (multiset difference), with their new line numbers. */
export function addedLines(prev: string, next: string): { line: number; text: string }[] {
  const counts = new Map<string, number>();
  for (const l of prev.split(/\r?\n/)) counts.set(l, (counts.get(l) ?? 0) + 1);
  const out: { line: number; text: string }[] = [];
  next.split(/\r?\n/).forEach((text, i) => {
    const n = counts.get(text) ?? 0;
    if (n > 0) counts.set(text, n - 1);
    else out.push({ line: i + 1, text });
  });
  return out;
}

function applyEdit(content: string, oldStr: string, newStr: string, all?: boolean): string {
  if (!oldStr) return content + newStr;
  if (all) return content.split(oldStr).join(newStr);
  const i = content.indexOf(oldStr);
  return i === -1 ? content : content.slice(0, i) + newStr + content.slice(i + oldStr.length);
}

interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, any>;
  cwd?: string;
  session_id?: string;
}

/** Translate a Claude Code tool call into the file changes it would make. */
export function changesFromToolCall(root: string, input: HookInput): FileChange[] {
  const tool = input.tool_name ?? "";
  const ti = input.tool_input ?? {};
  if (tool === "Bash" && typeof ti.command === "string") return changesFromShell(ti.command);
  const filePath: string | undefined = ti.file_path ?? ti.notebook_path;
  if (!filePath) return [];
  const abs = isAbsolute(filePath) ? filePath : resolve(input.cwd ?? root, filePath);
  const rel = relative(root, abs).replace(/\\/g, "/");
  if (rel.startsWith("..")) return []; // outside the project
  const prev = existsSync(abs) ? readFileSync(abs, "utf8") : "";
  let next: string;
  if (tool === "Write") next = String(ti.content ?? "");
  else if (tool === "Edit") next = applyEdit(prev, String(ti.old_string ?? ""), String(ti.new_string ?? ""), ti.replace_all);
  else if (tool === "MultiEdit") {
    next = prev;
    for (const e of ti.edits ?? []) next = applyEdit(next, String(e.old_string ?? ""), String(e.new_string ?? ""), e.replace_all);
  } else return [];
  return [{ path: rel, content: next, addedLines: addedLines(prev, next) }];
}

const INSTALLERS: { re: RegExp; manifest: string; line: (pkg: string) => string }[] = [
  { re: /\b(?:npm|pnpm|bun)\s+(?:install|i|add)\b([^&|;]*)/g, manifest: "package.json", line: (p) => `"${p}": "*"` },
  { re: /\byarn\s+add\b([^&|;]*)/g, manifest: "package.json", line: (p) => `"${p}": "*"` },
  { re: /\b(?:pip3?|uv\s+pip)\s+install\b([^&|;]*)/g, manifest: "requirements.txt", line: (p) => p },
  { re: /\b(?:poetry|uv)\s+add\b([^&|;]*)/g, manifest: "requirements.txt", line: (p) => p },
  { re: /\bcargo\s+add\b([^&|;]*)/g, manifest: "Cargo.toml", line: (p) => `${p} = "*"` },
  { re: /\bgo\s+get\b([^&|;]*)/g, manifest: "go.mod", line: (p) => `require ${p} v0.0.0` },
  { re: /\bbundle\s+add\b([^&|;]*)/g, manifest: "Gemfile", line: (p) => `gem "${p}"` },
];

/** Recognise package-install commands so forbidden dependencies are caught before they are installed. */
export function changesFromShell(command: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const inst of INSTALLERS) {
    for (const m of command.matchAll(inst.re)) {
      const pkgs = m[1]
        .split(/\s+/)
        .map((t) => t.replace(/^["']|["']$/g, ""))
        .filter((t) => t && !/^[-./~]/.test(t) && !t.includes("://"))
        .map((t) => t.replace(/^(@?[^@=<>~!\s[]+).*$/, "$1")) // strip version specifiers
        .map((t) => (inst.manifest === "go.mod" ? t.replace(/@.*$/, "") : t));
      if (!pkgs.length) continue;
      const lines = pkgs.map((p, i) => ({ line: i + 1, text: inst.line(p) }));
      changes.push({ path: inst.manifest, addedLines: lines, content: lines.map((l) => l.text).join("\n") });
    }
  }
  return changes;
}

/** PreToolUse: block the tool call (exit 2, reason on stderr) when it would break a settled decision. */
export async function runPreToolUse(session: Session, input: HookInput): Promise<{ exitCode: number; stderr?: string }> {
  const changes = changesFromToolCall(session.ctx.root, input);
  if (!changes.length) return { exitCode: 0 };
  const { decisions } = await session.cache.get();
  const relevant = session.forProject(decisions);
  if (!relevant.length) return { exitCode: 0 };
  const result = check(relevant, changes);
  if (result.filesChecked > 0 && (result.checked.length || result.violations.length)) {
    await session.cache.report(toCheckEvent(result, changes, { source: "hook", agent: "claude-code", blocked: true, project: session.ctx.project }));
  }
  if (!result.violations.length) return { exitCode: 0 };
  const report = violationReport(result, new DecisionGraph(decisions), true);
  return {
    exitCode: 2,
    stderr: `DecisionEngine blocked this ${input.tool_name} call.\n\n${report}\n\nDo not retry the same change. Either adjust the approach to respect the decision, or explain the conflict to the user and ask whether to supersede it.`,
  };
}

/** SessionStart: inject the settled decisions so the agent starts aligned. */
export async function sessionStartContext(session: Session): Promise<string> {
  const { decisions, stale } = await session.cache.get({ maxAgeMs: 0, timeoutMs: 3_000 });
  const accepted = session.forProject(decisions).filter((d) => d.status === "accepted");
  const parts = [
    "## Team decisions (DecisionEngine)",
    "",
    accepted.length
      ? `This project has ${accepted.length} settled decision(s), shared live across the team. Edits that break an enforced decision are blocked automatically. Before working in an area, call the \`decisions_for_paths\` MCP tool (or run \`de context <path>\`) to see the full rationale.`
      : "No decisions are recorded for this project yet.",
    ...(stale ? ["", "_(The DecisionEngine service was unreachable; this list may be out of date.)_"] : []),
    "",
    summaryMarkdown(accepted),
    "",
    "When the user settles a choice between alternatives (a library, a pattern, an architecture, a naming convention, a product rule), record it with the `record_decision` MCP tool (or `de new`), including the rejected options and why. It is shared with the whole team immediately. Do not record trivial choices.",
  ];
  return parts.join("\n").trim() + "\n";
}

// ---------------------------------------------------------------- installers

function readJson(path: string): any {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8").trim();
  return text ? JSON.parse(text) : {};
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function upsertHook(settings: any, event: string, matcher: string | undefined, command: string) {
  settings.hooks ??= {};
  const list: any[] = (settings.hooks[event] ??= []);
  const marker = /\bde(cisionengine)?\b.*\bhook\b/;
  for (const group of list) {
    group.hooks = (group.hooks ?? []).filter((h: any) => !(typeof h.command === "string" && marker.test(h.command)));
  }
  settings.hooks[event] = list.filter((g) => g.hooks.length);
  const entry: any = { hooks: [{ type: "command", command }] };
  if (matcher) entry.matcher = matcher;
  settings.hooks[event].push(entry);
}

export function installClaudeCode(root: string, bin = "de"): string[] {
  const done: string[] = [];
  const settingsPath = join(root, ".claude", "settings.json");
  const settings = readJson(settingsPath);
  upsertHook(settings, "PreToolUse", "Write|Edit|MultiEdit|Bash", `${bin} hook pre-tool-use`);
  upsertHook(settings, "SessionStart", undefined, `${bin} hook session-start`);
  writeJson(settingsPath, settings);
  done.push(`${relative(root, settingsPath)}: PreToolUse enforcement + SessionStart context hooks`);

  const mcpPath = join(root, ".mcp.json");
  const mcp = readJson(mcpPath);
  mcp.mcpServers ??= {};
  const [command, ...args] = bin.split(/\s+/);
  mcp.mcpServers.decisionengine = { command, args: [...args, "mcp"] };
  writeJson(mcpPath, mcp);
  done.push(`${relative(root, mcpPath)}: decisionengine MCP server`);
  return done;
}

export function installGitHook(root: string, bin = "de"): string {
  const hookPath = join(root, ".git", "hooks", "pre-commit");
  if (!existsSync(join(root, ".git"))) throw new Error("not a git repository");
  const exe = bin.split(/\s+/)[0];
  const line = `if command -v ${exe} >/dev/null 2>&1; then ${bin} check --staged || exit 1; else echo "DecisionEngine: '${exe}' not found, skipping decision check" >&2; fi`;
  let body = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : "#!/bin/sh\n";
  if (!body.includes(`${bin} check --staged`)) body = body.trimEnd() + `\n# DecisionEngine: block commits that break settled decisions\n${line}\n`;
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, body);
  chmodSync(hookPath, 0o755);
  return relative(root, hookPath);
}
