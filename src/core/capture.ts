/** Shared by the service and the CLI so both agree on what a capture request may hold. */

export type CaptureSource = "claude-code" | "git" | "notes";
export const CAPTURE_SOURCES: CaptureSource[] = ["claude-code", "git", "notes"];

/** Max characters accepted per capture request. Clients split larger material into several requests. */
export const MAX_CAPTURE_CHARS = 400_000;

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk-ant-|sk-|rk_live_|sk_live_|pk_live_)[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bde_[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/]+:)[^@\s]+(?=@)/gi,
  /\b((?:password|passwd|secret|api[_-]?key|token|access[_-]?key)\s*[:=]\s*["']?)[^\s"']{6,}/gi,
];

/** Best-effort removal of credentials before material leaves the developer's machine. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (_m, keep?: string) => (typeof keep === "string" ? `${keep}[redacted]` : "[redacted]"));
  return out;
}

/** Split text on line boundaries into pieces no longer than max characters. */
export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    const l = line.length > max ? line.slice(0, max) : line;
    if (cur.length + l.length + 1 > max && cur) {
      out.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + l;
  }
  if (cur) out.push(cur);
  return out;
}
