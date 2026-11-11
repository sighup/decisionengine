/**
 * Core domain types.
 *
 * A Decision is a settled choice: what was chosen, why, what was rejected,
 * where it applies, what it builds on, and (optionally) machine-checkable
 * rules that make it enforceable.
 */

export const STATUSES = ["proposed", "accepted", "superseded", "deprecated"] as const;
export type Status = (typeof STATUSES)[number];

export const DISCIPLINES = ["engineering", "design", "product", "business", "operations"] as const;

export interface RejectedOption {
  option: string;
  reason?: string;
}

/** Disallow a regex in files matching `paths` (only lines being added are checked in diff mode). */
export interface ForbidPatternRule {
  type: "forbid_pattern";
  pattern: string;
  flags?: string;
  paths?: string[];
  message?: string;
}

/** Every file matching `paths` that is touched must contain the regex. */
export interface RequirePatternRule {
  type: "require_pattern";
  pattern: string;
  flags?: string;
  paths: string[];
  message?: string;
}

/** Disallow adding packages to dependency manifests (package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml, Gemfile). */
export interface ForbidDependencyRule {
  type: "forbid_dependency";
  packages: string[];
  message?: string;
}

/** Disallow creating or modifying files matching `paths`. */
export interface ForbidPathRule {
  type: "forbid_path";
  paths: string[];
  message?: string;
}

export type Rule = ForbidPatternRule | RequirePatternRule | ForbidDependencyRule | ForbidPathRule;
export const RULE_TYPES = ["forbid_pattern", "require_pattern", "forbid_dependency", "forbid_path"] as const;

export interface Decision {
  /** Human-readable key, unique within a workspace, e.g. "DEC-042". */
  id: string;
  title: string;
  status: Status;
  /** Day the decision was made (YYYY-MM-DD). */
  date: string;
  author?: string;
  discipline?: string;
  tags: string[];
  /** Globs (relative to a project's repository root) this decision governs. Empty means everywhere. */
  scope: string[];
  /** Project slugs this decision applies to. Empty means every project in the workspace. */
  projects: string[];
  /** One-paragraph rationale. */
  why?: string;
  rejected: RejectedOption[];
  depends_on: string[];
  supersedes: string[];
  superseded_by?: string;
  rules: Rule[];
  /** Free-form markdown body (context, consequences, notes). */
  body: string;
  /** Where the decision was captured: cli, mcp, dashboard, import, api. */
  source?: string;
  /** Link back to where it was made (agent session, thread, doc). */
  source_ref?: string;
  /** Monotonic revision number; every change is kept in the revision history. */
  revision: number;
  created_at?: string;
  updated_at?: string;
}

/** Fields a client may supply when recording a decision. */
export interface DecisionInput {
  title: string;
  why?: string;
  status?: Status;
  date?: string;
  discipline?: string;
  tags?: string[];
  scope?: string[];
  projects?: string[];
  rejected?: RejectedOption[];
  depends_on?: string[];
  supersedes?: string[];
  rules?: Rule[];
  body?: string;
  source?: string;
  source_ref?: string;
}

export type DecisionPatch = Partial<Omit<DecisionInput, "supersedes">> & { note?: string };

export interface Revision {
  revision: number;
  author?: string;
  note?: string;
  created_at: string;
  snapshot: Decision;
}

/** A single file change under evaluation. */
export interface FileChange {
  path: string;
  /** Full new content of the file, when known. */
  content?: string;
  /** Lines being added (diff mode). When absent, every line of `content` counts as added. */
  addedLines?: { line: number; text: string }[];
  /** True when the file is being deleted. */
  deleted?: boolean;
}

export interface Violation {
  decision: Pick<Decision, "id" | "title" | "why">;
  rule: Rule;
  ruleIndex: number;
  path: string;
  line?: number;
  excerpt?: string;
  message: string;
}

export interface CheckResult {
  violations: Violation[];
  /** Accepted decisions whose scope intersects the change: the change's "blast radius". */
  touched: string[];
  /** Downstream decisions (transitively) that depend on a violated decision. */
  atRisk: string[];
  filesChecked: number;
}

/** A check run reported by a client (hook, CLI, MCP, CI). */
export interface CheckEvent {
  project?: string;
  source: "cli" | "hook" | "mcp" | "ci";
  agent?: string;
  files: string[];
  checked: string[];
  violations: { id: string; path: string; line?: number }[];
  blocked: boolean;
  ts?: string;
}

export interface DecisionStats {
  checks: number;
  violations: number;
  blocked: number;
  last_checked?: string;
}
