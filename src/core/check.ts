import { DecisionGraph, matchesAny } from "./graph.js";
import { evaluate } from "./rules.js";
import type { CheckEvent, CheckResult, Decision, FileChange, Rule } from "./types.js";

function ruleApplies(rule: Rule, decision: Decision, path: string): boolean {
  switch (rule.type) {
    case "forbid_pattern":
      return rule.paths?.length ? matchesAny(path, rule.paths) : decision.scope.length ? matchesAny(path, decision.scope) : true;
    case "require_pattern":
    case "forbid_path":
      return matchesAny(path, rule.paths);
    case "forbid_dependency":
      return /(^|\/)(package\.json|requirements[^/]*\.(txt|in)|pyproject\.toml|Pipfile|go\.mod|Cargo\.toml|Gemfile)$/.test(path);
  }
}

/** Run every accepted decision against `changes` and compute the blast radius. */
export function check(decisions: Decision[], changes: FileChange[]): CheckResult & { checked: string[] } {
  const graph = new DecisionGraph(decisions);
  const violations = evaluate(decisions, changes);
  const paths = changes.map((c) => c.path);

  const touched = new Set<string>();
  const checked = new Set<string>();
  for (const d of decisions) {
    if (d.status !== "accepted") continue;
    if (d.scope.length && paths.some((p) => matchesAny(p, d.scope))) touched.add(d.id);
    if (d.rules.some((r) => paths.some((p) => ruleApplies(r, d, p)))) checked.add(d.id);
  }
  for (const id of touched) checked.add(id);

  const violated = new Set(violations.map((v) => v.decision.id));
  return {
    violations,
    touched: [...touched],
    atRisk: graph.downstreamClosure(violated),
    filesChecked: paths.length,
    checked: [...checked],
  };
}

/** Shape a check result into the event reported to the service. */
export function toCheckEvent(
  result: ReturnType<typeof check>,
  changes: FileChange[],
  meta: { source: CheckEvent["source"]; blocked: boolean; agent?: string; project?: string },
): CheckEvent {
  return {
    project: meta.project,
    source: meta.source,
    agent: meta.agent,
    files: changes.map((c) => c.path).slice(0, 50),
    checked: result.checked,
    violations: result.violations.map((v) => ({ id: v.decision.id, path: v.path, line: v.line })),
    blocked: meta.blocked && result.violations.length > 0,
  };
}
