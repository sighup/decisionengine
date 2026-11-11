import YAML from "yaml";
import type { Decision } from "./types.js";
import { slugify } from "./validate.js";

/** Markdown + YAML frontmatter rendering of a decision, used by `de export`. */
export function toMarkdownFile(d: Decision): { name: string; content: string } {
  const fm: Record<string, unknown> = { id: d.id, title: d.title, status: d.status, date: d.date };
  if (d.author) fm.author = d.author;
  if (d.discipline) fm.discipline = d.discipline;
  if (d.tags.length) fm.tags = d.tags;
  if (d.projects.length) fm.projects = d.projects;
  if (d.scope.length) fm.scope = d.scope;
  if (d.why) fm.why = d.why;
  if (d.rejected.length) fm.rejected = d.rejected.map((r) => (r.reason ? r : { option: r.option }));
  if (d.depends_on.length) fm.depends_on = d.depends_on;
  if (d.supersedes.length) fm.supersedes = d.supersedes;
  if (d.superseded_by) fm.superseded_by = d.superseded_by;
  if (d.rules.length) fm.rules = d.rules;
  fm.revision = d.revision;
  if (d.source_ref) fm.source_ref = d.source_ref;
  const yaml = YAML.stringify(fm, { lineWidth: 0 }).trimEnd();
  const body = d.body?.trim() ? `\n${d.body.trim()}\n` : "";
  return { name: `${d.id}-${slugify(d.title)}.md`, content: `---\n${yaml}\n---\n${body}` };
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parse an exported decision file back into importable input (ids are reassigned on import). */
export function fromMarkdownFile(text: string): Record<string, unknown> & { id?: string } {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) throw new Error("missing YAML frontmatter");
  const fm = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>;
  if (fm.date instanceof Date) fm.date = fm.date.toISOString().slice(0, 10);
  return { ...fm, body: m[2].trim() };
}
