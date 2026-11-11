import { basename } from "node:path";
import { matchesAny } from "./graph.js";
import type { Decision, FileChange, Rule, Violation } from "./types.js";

const MAX_HITS_PER_FILE = 5;

/** Lines that carry `de-allow DEC-123` (or `de-allow: DEC-123`) are exempt from that decision's rules. */
function allowed(text: string, id: string): boolean {
  const m = /de-allow:?\s+([A-Z0-9-,\s]+)/i.exec(text);
  if (!m) return false;
  return m[1].split(/[\s,]+/).some((t) => t.toUpperCase() === id);
}

function linesOf(change: FileChange): { line: number; text: string }[] {
  if (change.addedLines) return change.addedLines;
  if (change.content == null) return [];
  return change.content.split(/\r?\n/).map((text, i) => ({ line: i + 1, text }));
}

function inRuleScope(path: string, rulePaths: string[] | undefined, decision: Decision): boolean {
  if (rulePaths?.length) return matchesAny(path, rulePaths);
  if (decision.scope.length) return matchesAny(path, decision.scope);
  return true;
}

function excerpt(text: string): string {
  const t = text.trim();
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
}

/** Evaluate one decision's rules against a set of changes. */
export function evaluateDecision(decision: Decision, changes: FileChange[]): Violation[] {
  const out: Violation[] = [];
  const ref = { id: decision.id, title: decision.title, why: decision.why };
  const push = (rule: Rule, ruleIndex: number, path: string, message: string, line?: number, text?: string) =>
    out.push({ decision: ref, rule, ruleIndex, path, line, excerpt: text != null ? excerpt(text) : undefined, message });

  decision.rules.forEach((rule, ruleIndex) => {
    for (const change of changes) {
      const path = change.path.replace(/\\/g, "/");

      switch (rule.type) {
        case "forbid_pattern": {
          if (change.deleted || !inRuleScope(path, rule.paths, decision)) break;
          const re = new RegExp(rule.pattern, (rule.flags ?? "").replace("g", ""));
          let hits = 0;
          for (const { line, text } of linesOf(change)) {
            if (!re.test(text) || allowed(text, decision.id)) continue;
            push(rule, ruleIndex, path, rule.message ?? `matches forbidden pattern /${rule.pattern}/`, line, text);
            if (++hits >= MAX_HITS_PER_FILE) break;
          }
          break;
        }
        case "require_pattern": {
          if (change.deleted || change.content == null || !matchesAny(path, rule.paths)) break;
          const re = new RegExp(rule.pattern, (rule.flags ?? "").replace("g", ""));
          if (!re.test(change.content) && !allowed(change.content, decision.id)) {
            push(rule, ruleIndex, path, rule.message ?? `must contain /${rule.pattern}/`);
          }
          break;
        }
        case "forbid_dependency": {
          if (change.deleted) break;
          const detector = manifestDetector(path);
          if (!detector) break;
          for (const { line, text } of linesOf(change)) {
            if (allowed(text, decision.id)) continue;
            for (const pkg of rule.packages) {
              if (detector(text, pkg)) {
                push(rule, ruleIndex, path, rule.message ?? `adds forbidden dependency "${pkg}"`, line, text);
              }
            }
          }
          break;
        }
        case "forbid_path": {
          if (change.deleted || !matchesAny(path, rule.paths)) break;
          push(rule, ruleIndex, path, rule.message ?? `path is off-limits (${rule.paths.join(", ")})`);
          break;
        }
      }
    }
  });
  return out;
}

/** Evaluate every accepted decision's rules. */
export function evaluate(decisions: Decision[], changes: FileChange[]): Violation[] {
  return decisions.filter((d) => d.status === "accepted" && d.rules.length).flatMap((d) => evaluateDecision(d, changes));
}

type Detector = (line: string, pkg: string) => boolean;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** PEP 503 normalisation: case-insensitive, runs of -_. are equivalent. */
const pyName = (s: string) => esc(s.toLowerCase()).replace(/(\\\.|[-_])+/g, "[-_.]+");

export function manifestDetector(path: string): Detector | undefined {
  const name = basename(path);
  if (name === "package.json") {
    return (line, pkg) => new RegExp(`"${esc(pkg)}"\\s*:\\s*"`).test(line) && !/^\s*"(name|main|types|module)"\s*:/.test(line);
  }
  if (/^requirements.*\.(txt|in)$/.test(name)) {
    return (line, pkg) => new RegExp(`^\\s*${pyName(pkg)}\\s*($|[<>=!~;\\[ ])`, "i").test(line);
  }
  if (name === "pyproject.toml" || name === "Pipfile") {
    return (line, pkg) =>
      new RegExp(`["']${pyName(pkg)}\\s*($|[<>=!~;\\[ "'])`, "i").test(line) ||
      new RegExp(`^\\s*${pyName(pkg)}\\s*=`, "i").test(line);
  }
  if (name === "go.mod") {
    return (line, pkg) => new RegExp(`(^|\\s)${esc(pkg)}(/v\\d+)?\\s+v\\d`).test(line);
  }
  if (name === "Cargo.toml") {
    return (line, pkg) => new RegExp(`^\\s*${esc(pkg)}\\s*=`).test(line);
  }
  if (name === "Gemfile") {
    return (line, pkg) => new RegExp(`^\\s*gem\\s+["']${esc(pkg)}["']`).test(line);
  }
  return undefined;
}
