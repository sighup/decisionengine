import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FileChange } from "./core/types.js";

export class GitError extends Error {}

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const stderr = String((e as { stderr?: unknown }).stderr ?? "").trim().split("\n")[0];
    throw new GitError(`git ${args[0]} failed: ${stderr || (e as Error).message}`);
  }
}

function tryGit(root: string, args: string[]): string | undefined {
  try {
    return git(root, args);
  } catch {
    return undefined;
  }
}

export function isGitRepo(root: string): boolean {
  return tryGit(root, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

function hasHead(root: string): boolean {
  return tryGit(root, ["rev-parse", "--verify", "HEAD"]) !== undefined;
}

/** Parse `git diff --unified=0` output into per-file added lines. */
export function parseUnifiedDiff(diff: string): FileChange[] {
  const changes: FileChange[] = [];
  let cur: FileChange | undefined;
  let lineNo = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      cur = undefined;
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4).trim();
      if (target === "/dev/null") {
        // Deleted file: we only learn the old name from the "--- a/" line, which we skipped; handled by name-status below.
        cur = undefined;
      } else {
        cur = { path: unquote(target).replace(/^b\//, ""), addedLines: [] };
        changes.push(cur);
      }
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(raw);
      lineNo = m ? Number(m[1]) : 0;
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("+")) {
      cur.addedLines!.push({ line: lineNo, text: raw.slice(1) });
      lineNo++;
    } else if (raw.startsWith(" ")) {
      lineNo++;
    }
  }
  return changes;
}

function unquote(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) return JSON.parse(p);
  return p;
}

function readWorking(root: string, path: string): string | undefined {
  const full = join(root, path);
  try {
    if (!existsSync(full) || !statSync(full).isFile()) return undefined;
    const buf = readFileSync(full);
    if (buf.includes(0)) return undefined; // binary
    return buf.toString("utf8");
  } catch {
    return undefined;
  }
}

export interface DiffOptions {
  /** Compare against the merge-base with this ref (CI / pull-request mode). */
  base?: string;
  /** Only staged changes (pre-commit mode). */
  staged?: boolean;
}

/** Collect the changes in a git repository as FileChanges with added lines and full new content. */
export function collectGitChanges(root: string, opts: DiffOptions = {}): FileChange[] {
  const common = ["--unified=0", "--no-color", "--no-ext-diff", "--no-renames"];
  let diff: string;
  let contentFrom: (path: string) => string | undefined = (p) => readWorking(root, p);

  if (opts.base) {
    diff = git(root, ["diff", ...common, `${opts.base}...HEAD`]);
    contentFrom = (p) => tryGit(root, ["show", `HEAD:${p}`]);
  } else if (opts.staged) {
    diff = git(root, ["diff", "--cached", ...common]);
    contentFrom = (p) => tryGit(root, ["show", `:${p}`]) ?? readWorking(root, p);
  } else if (!hasHead(root)) {
    // No commits yet: every tracked or untracked file is new.
    const files = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    const out: FileChange[] = [];
    for (const path of new Set(files)) {
      const content = readWorking(root, path);
      if (content != null) out.push({ path, content });
    }
    return out;
  } else {
    diff = git(root, ["diff", "HEAD", ...common]);
  }

  const changes = parseUnifiedDiff(diff);
  for (const c of changes) c.content = contentFrom(c.path);

  if (!opts.base && !opts.staged) {
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    for (const path of untracked) {
      const content = readWorking(root, path);
      if (content == null) continue;
      changes.push({ path, content });
    }
  }
  return changes;
}

export function gitUser(root: string): string | undefined {
  return tryGit(root, ["config", "user.name"])?.trim() || undefined;
}
