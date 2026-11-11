import picomatch from "picomatch";
import type { Decision } from "./types.js";

/** Read-only view over the decision set: lookups, dependency traversal and integrity checks. */
export class DecisionGraph {
  readonly byId = new Map<string, Decision>();
  private readonly dependents = new Map<string, string[]>();

  constructor(readonly decisions: Decision[]) {
    for (const d of decisions) this.byId.set(d.id, d);
    for (const d of decisions) {
      for (const up of d.depends_on) {
        const list = this.dependents.get(up) ?? [];
        list.push(d.id);
        this.dependents.set(up, list);
      }
    }
  }

  get(id: string): Decision | undefined {
    return this.byId.get(id);
  }

  /** Decisions this one directly builds on. */
  upstream(id: string): Decision[] {
    return (this.byId.get(id)?.depends_on ?? []).map((u) => this.byId.get(u)).filter(Boolean) as Decision[];
  }

  /** Decisions that directly build on this one. */
  downstream(id: string): Decision[] {
    return (this.dependents.get(id) ?? []).map((u) => this.byId.get(u)!).filter(Boolean);
  }

  /** Every decision that transitively depends on `ids` (excluding `ids` themselves). */
  downstreamClosure(ids: Iterable<string>): string[] {
    const start = new Set(ids);
    const seen = new Set<string>();
    const queue = [...start];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const next of this.dependents.get(cur) ?? []) {
        if (!seen.has(next) && !start.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return [...seen];
  }

  /** Every decision `id` transitively depends on. */
  upstreamClosure(id: string): string[] {
    const seen = new Set<string>();
    const queue = [...(this.byId.get(id)?.depends_on ?? [])];
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur) || cur === id) continue;
      seen.add(cur);
      queue.push(...(this.byId.get(cur)?.depends_on ?? []));
    }
    return [...seen];
  }

  /** Accepted decisions that govern `path`: scoped ones whose globs match, plus project-wide ones. */
  governing(path: string, opts: { includeGlobal?: boolean } = {}): Decision[] {
    const includeGlobal = opts.includeGlobal ?? true;
    return this.decisions.filter((d) => {
      if (d.status !== "accepted") return false;
      if (!d.scope.length) return includeGlobal;
      return matchesAny(path, d.scope);
    });
  }

  /** Integrity problems in the decision set. */
  lint(): LintIssue[] {
    const issues: LintIssue[] = [];
    const seen = new Map<string, number>();
    for (const d of this.decisions) seen.set(d.id, (seen.get(d.id) ?? 0) + 1);
    for (const [id, n] of seen) {
      if (n > 1) issues.push({ level: "error", id, message: `id ${id} is used by ${n} files` });
    }

    for (const d of this.decisions) {
      for (const up of d.depends_on) {
        const target = this.byId.get(up);
        if (!target) issues.push({ level: "error", id: d.id, message: `depends on ${up}, which does not exist` });
        else if (d.status === "accepted" && target.status !== "accepted") {
          const hint = target.superseded_by ? ` (replaced by ${target.superseded_by}; re-examine this decision)` : "";
          issues.push({ level: "warning", id: d.id, message: `depends on ${up}, which is ${target.status}${hint}` });
        }
      }
      for (const old of d.supersedes) {
        const target = this.byId.get(old);
        if (!target) issues.push({ level: "error", id: d.id, message: `supersedes ${old}, which does not exist` });
        else if (target.status !== "superseded") issues.push({ level: "warning", id: d.id, message: `supersedes ${old}, but ${old} is still ${target.status}` });
      }
      if (d.status === "superseded" && !d.superseded_by) {
        issues.push({ level: "warning", id: d.id, message: "is superseded but does not say by what (set superseded_by)" });
      }
      if (d.status === "accepted" && !d.why) {
        issues.push({ level: "info", id: d.id, message: "has no rationale (why); future readers will not know why it was made" });
      }
    }

    for (const cycle of this.cycles()) {
      issues.push({ level: "error", id: cycle[0], message: `dependency cycle: ${[...cycle, cycle[0]].join(" -> ")}` });
    }

    issues.push(...this.conflicts());
    return issues;
  }

  /** Accepted decisions whose rules contradict each other (one forbids what another requires). */
  conflicts(): LintIssue[] {
    const out: LintIssue[] = [];
    const accepted = this.decisions.filter((d) => d.status === "accepted");
    for (const a of accepted) {
      for (const ra of a.rules) {
        if (ra.type !== "require_pattern") continue;
        for (const b of accepted) {
          for (const rb of b.rules) {
            if (rb.type !== "forbid_pattern" || rb.pattern !== ra.pattern) continue;
            const overlap = !rb.paths?.length || ra.paths.some((p) => rb.paths!.some((q) => globsMayOverlap(p, q)));
            if (overlap) {
              out.push({
                level: "error",
                id: a.id,
                message: `conflicts with ${b.id}: ${a.id} requires /${ra.pattern}/ where ${b.id} forbids it`,
              });
            }
          }
        }
      }
      for (const ra of a.rules) {
        if (ra.type !== "forbid_path") continue;
        for (const b of accepted) {
          if (b.id === a.id) continue;
          for (const rb of b.rules) {
            if (rb.type !== "require_pattern") continue;
            if (rb.paths.some((p) => ra.paths.some((q) => globsMayOverlap(p, q)))) {
              out.push({ level: "warning", id: a.id, message: `may conflict with ${b.id}: forbids paths that ${b.id} expects to exist` });
            }
          }
        }
      }
    }
    return out;
  }

  private cycles(): string[][] {
    const out: string[][] = [];
    const state = new Map<string, 1 | 2>();
    const stack: string[] = [];
    const visit = (id: string) => {
      state.set(id, 1);
      stack.push(id);
      for (const up of this.byId.get(id)?.depends_on ?? []) {
        if (!this.byId.has(up)) continue;
        const s = state.get(up);
        if (s === 1) out.push(stack.slice(stack.indexOf(up)));
        else if (!s) visit(up);
      }
      stack.pop();
      state.set(id, 2);
    };
    for (const d of this.decisions) if (!state.get(d.id)) visit(d.id);
    return out;
  }
}

export interface LintIssue {
  level: "error" | "warning" | "info";
  id: string;
  message: string;
}

const matcherCache = new Map<string, (p: string) => boolean>();

export function matchesAny(path: string, globs: string[]): boolean {
  const norm = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return globs.some((g) => {
    let m = matcherCache.get(g);
    if (!m) {
      m = picomatch(g, { dot: true });
      matcherCache.set(g, m);
    }
    return m(norm);
  });
}

/** Conservative overlap test for two globs: equal, or either one's static prefix contains the other's. */
function globsMayOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const prefix = (g: string) => g.split(/[*?[{]/)[0];
  const pa = prefix(a);
  const pb = prefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}
