import { DecisionGraph } from "./graph.js";
import type { CheckResult, Decision, DecisionStats, Rule } from "./types.js";

const useColor = () => !!process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: number) => (s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = { bold: wrap(1), dim: wrap(2), red: wrap(31), green: wrap(32), yellow: wrap(33), cyan: wrap(36) };

export function describeRule(r: Rule): string {
  switch (r.type) {
    case "forbid_pattern":
      return `forbid /${r.pattern}/${r.flags ?? ""}${r.paths?.length ? ` in ${r.paths.join(", ")}` : ""}`;
    case "require_pattern":
      return `require /${r.pattern}/${r.flags ?? ""} in ${r.paths.join(", ")}`;
    case "forbid_dependency":
      return `forbid dependency ${r.packages.join(", ")}`;
    case "forbid_path":
      return `forbid changes to ${r.paths.join(", ")}`;
  }
}

/** Compact markdown for agents: the decision, the reasoning, what not to do. */
export function decisionMarkdown(d: Decision, opts: { graph?: DecisionGraph; full?: boolean } = {}): string {
  const lines = [`### ${d.id}: ${d.title}`, ""];
  const meta = [`status: ${d.status}`, d.date && `date: ${d.date}`, d.author && `by: ${d.author}`, d.tags.length && `tags: ${d.tags.join(", ")}`]
    .filter(Boolean)
    .join(" · ");
  lines.push(meta);
  if (d.scope.length) lines.push(`scope: ${d.scope.join(", ")}`);
  if (d.superseded_by) lines.push(`superseded by: ${d.superseded_by}`);
  if (d.why) lines.push("", `**Why:** ${d.why}`);
  if (d.rejected.length) {
    lines.push("", "**Rejected:**");
    for (const r of d.rejected) lines.push(`- ${r.option}${r.reason ? ` — ${r.reason}` : ""}`);
  }
  if (d.rules.length) {
    lines.push("", "**Enforced rules:**");
    for (const r of d.rules) lines.push(`- ${describeRule(r)}${r.message ? ` (${r.message})` : ""}`);
  }
  if (opts.graph) {
    const up = opts.graph.upstream(d.id);
    const down = opts.graph.downstream(d.id);
    if (up.length) lines.push("", `**Builds on:** ${up.map((u) => `${u.id} ${u.title}`).join("; ")}`);
    if (down.length) lines.push("", `**Depended on by:** ${down.map((u) => `${u.id} ${u.title}`).join("; ")}`);
  }
  if (opts.full && d.body) lines.push("", d.body);
  return lines.join("\n");
}

export function contextMarkdown(decisions: Decision[], paths: string[], graph: DecisionGraph): string {
  if (!decisions.length) {
    return paths.length
      ? `No accepted decisions govern ${paths.join(", ")}.`
      : "No accepted decisions recorded yet.";
  }
  const header = paths.length
    ? `# Decisions governing ${paths.join(", ")}\n\nThese are settled. Follow them; if a change requires breaking one, stop and ask the user to supersede it first.`
    : `# Accepted decisions\n\nThese are settled. Follow them; if a change requires breaking one, stop and ask the user to supersede it first.`;
  return [header, ...decisions.map((d) => decisionMarkdown(d, { graph }))].join("\n\n");
}

/** One line per decision, for session-start injection where space matters. */
export function summaryMarkdown(decisions: Decision[]): string {
  if (!decisions.length) return "";
  const lines = decisions.map((d) => {
    const scope = d.scope.length ? ` [${d.scope.join(", ")}]` : "";
    const why = d.why ? ` — ${d.why.split(/(?<=\.)\s/)[0]}` : "";
    return `- ${d.id} ${d.title}${scope}${why}`;
  });
  return lines.join("\n");
}

export function violationReport(result: CheckResult, graph: DecisionGraph, plain = false): string {
  const col = plain ? { bold: (s: string) => s, dim: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s, cyan: (s: string) => s, green: (s: string) => s } : c;
  if (!result.violations.length) return col.green(`No decision violations in ${result.filesChecked} file(s).`);
  const out: string[] = [];
  const byDecision = new Map<string, typeof result.violations>();
  for (const v of result.violations) {
    const list = byDecision.get(v.decision.id) ?? [];
    list.push(v);
    byDecision.set(v.decision.id, list);
  }
  out.push(col.red(col.bold(`${result.violations.length} violation(s) of ${byDecision.size} settled decision(s):`)));
  for (const [id, vs] of byDecision) {
    const d = vs[0].decision;
    out.push("", col.bold(`${id}: ${d.title}`));
    if (d.why) out.push(col.dim(`  Why: ${d.why}`));
    const full = graph.get(id);
    if (full?.rejected.length) out.push(col.dim(`  Rejected: ${full.rejected.map((r) => r.option).join("; ")}`));
    for (const v of vs) {
      const loc = v.line ? `${v.path}:${v.line}` : v.path;
      out.push(`  ${col.red("✗")} ${col.cyan(loc)} ${v.message}`);
      if (v.excerpt) out.push(col.dim(`      ${v.excerpt}`));
    }
    const down = graph.downstreamClosure([id]);
    if (down.length) out.push(col.yellow(`  ${down.length} downstream decision(s) depend on this: ${down.slice(0, 8).join(", ")}${down.length > 8 ? ", ..." : ""}`));
  }
  out.push(
    "",
    "To proceed, change the code to respect these decisions, or supersede the decision (`de supersede <id>`) if it no longer holds.",
    "A single line can be exempted with a `de-allow <id>` comment.",
  );
  return out.join("\n");
}

export interface DigestInput {
  decisions: Decision[];
  stats: Record<string, DecisionStats>;
  totals: { checks: number; blocked: number; violations: number };
  since: Date;
}

export function digestMarkdown({ decisions, stats, totals, since }: DigestInput): string {
  const sinceIso = since.toISOString();
  const graph = new DecisionGraph(decisions);
  const made = decisions.filter((d) => (d.created_at ?? d.date) >= sinceIso.slice(0, (d.created_at ? 24 : 10)) && (d.status === "accepted" || d.status === "proposed"));
  const replaced = decisions.filter((d) => d.status === "superseded" && d.superseded_by && (d.updated_at ?? "") >= sinceIso);
  const lines = [`# Decision digest since ${sinceIso.slice(0, 10)}`, ""];

  lines.push(`## New decisions (${made.length})`, "");
  if (!made.length) lines.push("_None._");
  for (const d of made) {
    const deps = d.depends_on.length ? ` (builds on ${d.depends_on.join(", ")})` : "";
    const who = d.author ? ` · ${d.author}` : "";
    lines.push(`- **${d.id} ${d.title}**${d.status === "proposed" ? " _(proposed)_" : ""}${deps}${who}${d.why ? ` — ${d.why}` : ""}`);
  }
  lines.push("", `## Reversed or replaced (${replaced.length})`, "");
  if (!replaced.length) lines.push("_None._");
  for (const d of replaced) lines.push(`- ~~${d.id} ${d.title}~~ → ${d.superseded_by} ${graph.get(d.superseded_by!)?.title ?? ""}`);

  lines.push("", "## Enforcement", "");
  lines.push(`${totals.checks} check(s), ${totals.violations} violation(s) caught, ${totals.blocked} change(s) blocked.`);
  const top = Object.entries(stats).sort((a, b) => b[1].violations - a[1].violations || b[1].checks - a[1].checks).slice(0, 10);
  if (top.length) {
    lines.push("", "| Decision | Checks | Violations caught |", "|---|---:|---:|");
    for (const [id, s] of top) lines.push(`| ${id} ${graph.get(id)?.title ?? ""} | ${s.checks} | ${s.violations} |`);
  }

  const issues = graph.lint().filter((i) => i.level !== "info");
  if (issues.length) {
    lines.push("", "## Needs attention", "");
    for (const i of issues) lines.push(`- ${i.id} ${i.message}`);
  }
  return lines.join("\n");
}
