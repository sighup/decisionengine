import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ApiClient } from "./client/api.js";
import type { Decision, DecisionInput, Status } from "./core/types.js";

/**
 * Import existing Architecture Decision Records (Nygard-style or MADR) so a
 * team starts with its history mapped instead of a blank slate.
 */

interface ParsedAdr {
  key: string;
  input: DecisionInput;
  supersededByKey?: string;
  supersedesKeys: string[];
}

function sections(md: string): Map<string, string> {
  const map = new Map<string, string>();
  const parts = md.split(/^##\s+/m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf("\n");
    const head = (nl === -1 ? p : p.slice(0, nl)).trim().toLowerCase();
    map.set(head, (nl === -1 ? "" : p.slice(nl + 1)).trim());
  }
  return map;
}

function firstParagraph(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const p = s.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
  return p || undefined;
}

function toStatus(raw: string): Status {
  const s = raw.toLowerCase();
  if (s.includes("superseded")) return "superseded";
  if (s.includes("deprecat") || s.includes("reject")) return "deprecated";
  if (s.includes("propos") || s.includes("draft")) return "proposed";
  return "accepted";
}

function adrKey(file: string): string {
  const m = /^(\d+)/.exec(basename(file));
  return m ? String(Number(m[1])) : basename(file, ".md");
}

export function parseAdr(md: string, file: string): ParsedAdr {
  let text = md;
  let fmStatus: string | undefined;
  let fmDate: string | undefined;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (fm) {
    fmStatus = /^status:\s*(.+)$/im.exec(fm[1])?.[1]?.trim();
    fmDate = /^date:\s*(.+)$/im.exec(fm[1])?.[1]?.trim();
    text = text.slice(fm[0].length);
  }
  const titleLine = /^#\s+(.+)$/m.exec(text)?.[1] ?? basename(file, ".md");
  const title = titleLine.replace(/^(ADR[-\s]?)?\d+[.:]?\s*/i, "").trim();
  const secs = sections(text);

  const statusText = fmStatus ?? secs.get("status") ?? /^Status:\s*(.+)$/im.exec(text)?.[1] ?? "accepted";
  const date = fmDate ?? /^Date:\s*(\d{4}-\d{2}-\d{2})/im.exec(text)?.[1] ?? statSync(file).mtime.toISOString().slice(0, 10);

  const supersededBy = /superseded by\s*\[?[^\]\n]*?(\d+)/i.exec(statusText)?.[1];
  const supersedes = [...(secs.get("status") ?? "").matchAll(/supersedes\s*\[?[^\]\n]*?(\d+)/gi)].map((m) => String(Number(m[1])));

  // MADR: "Chosen option: "X", because Y"
  const outcome = secs.get("decision outcome");
  const chosen = outcome ? /chosen option:\s*"?([^",\n]+)"?/i.exec(outcome)?.[1]?.trim() : undefined;
  const because = outcome ? /because[,:]?\s*(.+)/i.exec(outcome)?.[1]?.trim() : undefined;

  const rejected: { option: string; reason?: string }[] = [];
  const considered = secs.get("considered options");
  if (considered) {
    for (const line of considered.split("\n")) {
      const opt = /^\s*[-*]\s+(.+)$/.exec(line)?.[1]?.replace(/[*_`]/g, "").trim();
      if (opt && (!chosen || !opt.toLowerCase().startsWith(chosen.toLowerCase()))) rejected.push({ option: opt });
    }
  }

  const why = because ?? firstParagraph(secs.get("decision")) ?? firstParagraph(secs.get("context"));
  return {
    key: adrKey(file),
    supersededByKey: supersededBy ? String(Number(supersededBy)) : undefined,
    supersedesKeys: supersedes,
    input: {
      title,
      status: toStatus(statusText),
      date,
      why,
      rejected,
      tags: ["imported-adr"],
      body: `_Imported from ${file}_\n\n${text.replace(/^#\s+.+\n/, "").trim()}`,
    },
  };
}

export function parseAdrDir(dir: string): ParsedAdr[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !/^(readme|index|template)/i.test(f))
    .sort()
    .map((f) => join(dir, f))
    .map((f) => parseAdr(readFileSync(f, "utf8"), f));
}

/** Import every ADR in `dir` into the workspace, preserving supersession chains. */
export async function importAdrs(api: ApiClient, dir: string): Promise<Decision[]> {
  const parsed = parseAdrDir(dir);
  const predecessors = new Map<string, Set<string>>();
  for (const p of parsed) {
    if (p.supersededByKey) (predecessors.get(p.supersededByKey) ?? predecessors.set(p.supersededByKey, new Set()).get(p.supersededByKey)!).add(p.key);
    for (const old of p.supersedesKeys) (predecessors.get(p.key) ?? predecessors.set(p.key, new Set()).get(p.key)!).add(old);
  }
  const hasSuccessor = new Set([...predecessors.values()].flatMap((s) => [...s]));
  const keyToId = new Map<string, string>();
  const created: Decision[] = [];
  for (const p of parsed) {
    const supersedes = [...(predecessors.get(p.key) ?? [])].map((k) => keyToId.get(k)).filter(Boolean) as string[];
    let status = p.input.status;
    // A superseded record is imported as accepted and flipped when its successor arrives.
    if (status === "superseded") status = hasSuccessor.has(p.key) ? "accepted" : "deprecated";
    const { decision } = await api.create({ ...p.input, status, supersedes, source: "import" });
    keyToId.set(p.key, decision.id);
    created.push(decision);
  }
  return Promise.all(created.map(async (d) => (await api.decision(d.id)).decision));
}
