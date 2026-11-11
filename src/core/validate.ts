import { RULE_TYPES, STATUSES, type DecisionInput, type Rule } from "./types.js";

export class ValidationError extends Error {}

export const KEY_RE = /^([A-Z][A-Z0-9]*)-(\d+)$/;

export function keyNumber(key: string): number {
  const m = KEY_RE.exec(key);
  return m ? Number(m[2]) : Number.MAX_SAFE_INTEGER;
}

export function formatKey(prefix: string, n: number, width = 3): string {
  return `${prefix}-${String(n).padStart(width, "0")}`;
}

/** Accept "12", "dec-12", "DEC-012" and return the canonical key. */
export function normalizeKey(raw: string, prefix = "DEC", width = 3): string {
  const t = raw.trim().toUpperCase();
  if (/^\d+$/.test(t)) return formatKey(prefix, Number(t), width);
  const m = KEY_RE.exec(t);
  return m ? formatKey(m[1], Number(m[2]), width) : t;
}

export function validateRules(rules: unknown, where = "rule"): Rule[] {
  if (rules == null) return [];
  if (!Array.isArray(rules)) throw new ValidationError("rules must be an array");
  rules.forEach((r: any, i) => {
    const at = `${where} #${i + 1}`;
    if (!r || !RULE_TYPES.includes(r.type)) throw new ValidationError(`${at}: unknown rule type "${r?.type}"`);
    if (r.type === "forbid_pattern" || r.type === "require_pattern") {
      if (typeof r.pattern !== "string" || !r.pattern) throw new ValidationError(`${at}: pattern is required`);
      try {
        new RegExp(r.pattern, r.flags);
      } catch (e) {
        throw new ValidationError(`${at}: bad regex: ${(e as Error).message}`);
      }
    }
    if ((r.type === "require_pattern" || r.type === "forbid_path") && !(Array.isArray(r.paths) && r.paths.length)) {
      throw new ValidationError(`${at}: paths is required`);
    }
    if (r.type === "forbid_dependency" && !(Array.isArray(r.packages) && r.packages.length)) {
      throw new ValidationError(`${at}: packages is required`);
    }
  });
  return rules as Rule[];
}

const strArr = (v: unknown, name: string): string[] => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ValidationError(`${name} must be an array of strings`);
  return v.map((x) => x.trim()).filter(Boolean);
};

/** Validate and normalise untrusted input for a new decision. */
export function validateInput(input: any): DecisionInput {
  if (!input || typeof input !== "object") throw new ValidationError("body must be an object");
  if (typeof input.title !== "string" || !input.title.trim()) throw new ValidationError("title is required");
  if (input.status != null && !STATUSES.includes(input.status)) throw new ValidationError(`invalid status "${input.status}"`);
  if (input.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(input.date))) throw new ValidationError("date must be YYYY-MM-DD");
  const rejected = (input.rejected ?? []).map((r: any) =>
    typeof r === "string" ? { option: r } : { option: String(r?.option ?? "").trim(), reason: r?.reason ? String(r.reason).trim() : undefined },
  );
  if (rejected.some((r: any) => !r.option)) throw new ValidationError("every rejected entry needs an option");
  return {
    title: input.title.trim(),
    why: input.why ? String(input.why).trim() : undefined,
    status: input.status,
    date: input.date,
    discipline: input.discipline ? String(input.discipline) : undefined,
    tags: strArr(input.tags, "tags"),
    scope: strArr(input.scope, "scope"),
    projects: strArr(input.projects, "projects"),
    rejected,
    depends_on: strArr(input.depends_on, "depends_on").map((k) => normalizeKey(k)),
    supersedes: strArr(input.supersedes, "supersedes").map((k) => normalizeKey(k)),
    rules: validateRules(input.rules),
    body: input.body ? String(input.body) : undefined,
    source: input.source ? String(input.source) : undefined,
    source_ref: input.source_ref ? String(input.source_ref) : undefined,
  };
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "decision"
  );
}
