import { spawn, execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { chunkText, redactSecrets, type CaptureSource } from "../core/capture.js";
import { extractionPrompt, parseJsonReply } from "../core/extraction.js";
import type { Decision } from "../core/types.js";
import { askClaudeCode, claudeCodeAvailable } from "./claude-local.js";
import { cacheDir } from "./config.js";
import type { Session } from "./session.js";

/**
 * Developer-side half of automatic capture. The Claude Code `Stop` and
 * `SessionEnd` hooks hand us a transcript path; we send the part of the
 * conversation the service has not seen yet, and the service turns any
 * settled decisions in it into proposals for a person to accept.
 */

export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
}

const NOISE = /<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // Only what people and the agent actually said: no tool calls, tool output or thinking.
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n");
}

/** Parse a Claude Code transcript (JSONL) into the conversation's text turns, in order. */
export function parseTranscript(jsonl: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if ((e.type !== "user" && e.type !== "assistant") || e.isMeta || e.isSidechain || e.isCompactSummary) continue;
    const role = e.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textOf(e.message?.content).replace(NOISE, "").trim();
    if (!text) continue;
    const prev = out[out.length - 1];
    // Assistant replies are written as several entries; join consecutive ones.
    if (prev && prev.role === role && role === "assistant") prev.text += "\n" + text;
    else out.push({ role, text });
  }
  return out;
}

export function renderMessages(msgs: TranscriptMessage[]): string {
  return msgs.map((m) => `${m.role === "user" ? "Developer" : "Agent"}: ${m.text}`).join("\n\n");
}

// ------------------------------------------------------------------ who runs the model

export class CaptureUnavailableError extends Error {}

/** Material per extraction request: modest pieces keep the model careful. */
export const CHUNK_CHARS = 120_000;

export type Extraction = "server" | "claude-code";

/**
 * Pick who reads the material: the service when it has its own key, else the
 * developer's own Claude Code (`claude -p`). Without either, capture is off.
 */
export async function chooseExtraction(s: Session, prefer?: Extraction): Promise<Extraction> {
  const status = await s.api.captureStatus();
  if (prefer === "claude-code" || !status.server_extraction) {
    if (claudeCodeAvailable()) return "claude-code";
    if (prefer === "claude-code") throw new CaptureUnavailableError("Claude Code (`claude`) is not installed or not on PATH.");
    throw new CaptureUnavailableError(`Capture needs Claude Code (\`claude\`) on this machine, or ANTHROPIC_API_KEY on ${s.ctx.server}.`);
  }
  return "server";
}

/**
 * Turn material into proposals: chunked, redacted, and sent oldest first so
 * each piece is read against the proposals the pieces before it produced.
 */
export async function captureMaterial(
  s: Session,
  opts: { source: CaptureSource; text: string; ref?: string; what: string; via: Extraction; onChunk?: (i: number, n: number, found: Decision[]) => void },
): Promise<Decision[]> {
  const parts = chunkText(redactSecrets(opts.text), CHUNK_CHARS);
  const found: Decision[] = [];
  for (const [i, part] of parts.entries()) {
    const base = { source: opts.source, source_ref: opts.ref, project: s.ctx.project };
    let res;
    if (opts.via === "server") res = await s.api.capture({ ...base, text: part });
    else {
      const { decisions } = await s.api.decisions();
      const reply = await askClaudeCode(extractionPrompt(s.forProject(decisions), opts.what), part);
      res = await s.api.capture({ ...base, output: parseJsonReply(reply) });
    }
    const got = res.proposals.map((p) => p.decision);
    found.push(...got);
    opts.onChunk?.(i, parts.length, got);
  }
  return found;
}

// ------------------------------------------------------------------ session capture

/** Send once this many new turns have accumulated (Stop fires after every agent reply). */
export const CAPTURE_MIN_NEW = 6;
/** Earlier turns sent along for context, so a decision that spans the boundary still reads as one. */
export const CAPTURE_CONTEXT = 6;

interface CaptureState {
  /** Number of transcript messages already sent. */
  sent: number;
  at?: string;
  disabled?: boolean;
  /** Set when the Claude Code plugin captures this session itself, so the hook path stands aside. */
  plugin?: boolean;
}

const stateDir = () => join(cacheDir(), "captures");
const stateKey = (sessionId: string) => createHash("sha256").update(sessionId).digest("hex").slice(0, 24);

function readState(sessionId: string): CaptureState {
  try {
    return JSON.parse(readFileSync(join(stateDir(), `${stateKey(sessionId)}.json`), "utf8"));
  } catch {
    return { sent: 0 };
  }
}

function writeState(sessionId: string, st: CaptureState) {
  mkdirSync(stateDir(), { recursive: true });
  const p = join(stateDir(), `${stateKey(sessionId)}.json`);
  writeFileSync(p + ".tmp", JSON.stringify(st));
  renameSync(p + ".tmp", p);
}

/** A per-session lock so overlapping Stop hooks never send the same turns twice. */
function withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T | undefined> {
  mkdirSync(stateDir(), { recursive: true });
  const lock = join(stateDir(), `${stateKey(sessionId)}.lock`);
  try {
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 15 * 60_000) unlinkSync(lock); // stale
    closeSync(openSync(lock, "wx"));
  } catch {
    return Promise.resolve(undefined);
  }
  return fn().finally(() => {
    try {
      unlinkSync(lock);
    } catch {}
  });
}

export interface SessionCaptureResult {
  status: "sent" | "waiting" | "nothing" | "disabled" | "busy";
  proposals?: Decision[];
}

/**
 * Send the unsent part of a Claude Code session for extraction.
 * Without `final`, waits until enough new turns have built up.
 */
export async function captureSession(
  s: Session,
  opts: { transcript: string; sessionId: string; final?: boolean },
): Promise<SessionCaptureResult> {
  const r = await withLock(opts.sessionId, async (): Promise<SessionCaptureResult> => {
    const st = readState(opts.sessionId);
    if (st.disabled || st.plugin) return { status: "disabled" };
    const msgs = parseTranscript(readFileSync(opts.transcript, "utf8"));
    // The transcript can shrink (e.g. a rewind); start over rather than skip.
    const sent = Math.min(st.sent, msgs.length);
    const fresh = msgs.slice(sent);
    if (!fresh.some((m) => m.role === "user")) return { status: "nothing" };
    if (!opts.final && fresh.length < CAPTURE_MIN_NEW) return { status: "waiting" };

    const context = msgs.slice(Math.max(0, sent - CAPTURE_CONTEXT), sent);
    const header = context.length ? `[Earlier in the conversation, already reviewed; for context only]\n${renderMessages(context)}\n\n[New since then]\n` : "";
    let via: Extraction;
    try {
      via = await chooseExtraction(s);
    } catch (e) {
      if (!(e instanceof CaptureUnavailableError)) throw e;
      writeState(opts.sessionId, { ...st, disabled: true });
      return { status: "disabled" };
    }
    const proposals = await captureMaterial(s, {
      source: "claude-code",
      text: header + renderMessages(fresh),
      ref: `claude-code:${opts.sessionId}`,
      what: "the conversation between a developer and their coding agent below (only the part marked new, if marked)",
      via,
    });
    writeState(opts.sessionId, { sent: msgs.length, at: new Date().toISOString() });
    return { status: "sent", proposals };
  });
  return r ?? { status: "busy" };
}

/** Mark a session as captured by the Claude Code plugin; the Stop/SessionEnd hook path then skips it. */
export function claimSessionForPlugin(sessionId: string) {
  writeState(sessionId, { ...readState(sessionId), plugin: true });
}

/**
 * Hand capture to a detached child process so the hook returns at once:
 * extraction takes far longer than an agent should wait.
 */
export function spawnSessionCapture(input: { transcript_path?: string; session_id?: string; cwd?: string }, final: boolean): boolean {
  if (process.env.DE_CAPTURE === "off" || !input.transcript_path || !input.session_id) return false;
  const args = [process.argv[1], "capture-session", "--transcript", input.transcript_path, "--session", input.session_id];
  if (final) args.push("--final");
  const child = spawn(process.execPath, [...process.execArgv, ...args], {
    cwd: input.cwd || process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  return true;
}

// ------------------------------------------------------------------ git history

export interface CommitInfo {
  hash: string;
  date: string;
  author: string;
  subject: string;
  body: string;
  files: string[];
}

const SEP = "\x1e";
const FS = "\x1f";

export function readCommits(root: string, opts: { since?: string; limit?: number; range?: string } = {}): CommitInfo[] {
  const args = ["log", "--no-merges", "--reverse", `--format=${SEP}%H${FS}%ad${FS}%an${FS}%s${FS}%b${FS}`, "--date=short", "--name-only"];
  if (opts.since) args.push(`--since=${opts.since}`);
  if (opts.range) args.push(opts.range);
  const out = execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  let commits = out
    .split(SEP)
    .filter((c) => c.trim())
    .map((c) => {
      const [hash, date, author, subject, body, files] = c.split(FS);
      return { hash, date, author, subject: subject.trim(), body: body.trim(), files: (files ?? "").split("\n").map((f) => f.trim()).filter(Boolean) };
    });
  if (opts.limit) commits = commits.slice(-opts.limit);
  return commits;
}

export function renderCommits(commits: CommitInfo[]): string {
  return commits
    .map((c) => {
      const files = c.files.length > 12 ? [...c.files.slice(0, 12), `… ${c.files.length - 12} more`] : c.files;
      return [`commit ${c.hash.slice(0, 10)} (${c.date}, ${c.author})`, c.subject, c.body, files.length ? `files: ${files.join(", ")}` : ""].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

/** Group commits into request-sized batches, oldest first, so later batches see earlier proposals. */
export function batchCommits(commits: CommitInfo[], maxChars: number): CommitInfo[][] {
  const batches: CommitInfo[][] = [];
  let cur: CommitInfo[] = [];
  let size = 0;
  for (const c of commits) {
    const n = renderCommits([c]).length + 2;
    if (cur.length && size + n > maxChars) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(c);
    size += n;
  }
  if (cur.length) batches.push(cur);
  return batches;
}
