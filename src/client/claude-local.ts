import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Extraction on the developer's own Claude: `claude -p`, signed in the way
 * they already use Claude Code, so no Anthropic key is needed anywhere.
 * The model gets no tools, runs outside the repository (so its project hooks
 * do not fire) and with DecisionEngine capture off (so it is never captured).
 */

const bin = () => process.env.DE_CLAUDE_BIN || "claude";

export function claudeCodeAvailable(): boolean {
  if (process.env.DE_CAPTURE_LOCAL === "off") return false;
  try {
    execFileSync(bin(), ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch (e) {
    if (process.env.DE_DEBUG) console.error(e);
    return false;
  }
}

export function askClaudeCode(prompt: string, material: string, timeoutMs = 10 * 60_000): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "de-extract-"));
  const args = ["-p", prompt, "--output-format", "text", "--tools", "", "--no-session-persistence"];
  if (process.env.DE_CAPTURE_MODEL) args.push("--model", process.env.DE_CAPTURE_MODEL);
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      bin(),
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, DE_CAPTURE: "off" } },
      (err, stdout, stderr) => {
        rmSync(cwd, { recursive: true, force: true });
        if (err) reject(new Error(`claude -p failed: ${(stderr || err.message).trim().split("\n")[0]}`));
        else resolve(stdout);
      },
    );
    child.stdin?.end(material);
  });
}
