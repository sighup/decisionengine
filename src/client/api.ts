import type { CheckEvent, Decision, DecisionPatch, DecisionStats, Revision } from "../core/types.js";
import type { LintIssue } from "../core/graph.js";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class OfflineError extends Error {}

export interface Me {
  member: { id: string; name: string; email: string; role: string };
  workspace: { id: string; name: string; key_prefix: string };
  projects: { id: string; slug: string; name: string; repo_url?: string }[];
}

/** Thin typed client for the DecisionEngine HTTP API. */
export class ApiClient {
  constructor(readonly server: string, readonly token?: string) {}

  async request<T>(method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.server + path, {
        method,
        headers: {
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new OfflineError(`cannot reach ${this.server}: ${(e as Error).message}`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) throw new ApiError(data?.error ?? `HTTP ${res.status}`, res.status);
    return data as T;
  }

  health() {
    return this.request<{ ok: boolean; version: string; setup_required: boolean }>("GET", "/healthz");
  }
  setup(b: { workspace: string; name: string; email: string; prefix?: string }) {
    return this.request<{ token: string; workspace: Me["workspace"]; member: Me["member"] }>("POST", "/v1/setup", b);
  }
  me() {
    return this.request<Me>("GET", "/v1/me");
  }
  members() {
    return this.request<{ members: Me["member"][] }>("GET", "/v1/members");
  }
  invite(b: { name: string; email: string; role?: string }) {
    return this.request<{ member: Me["member"]; token: string }>("POST", "/v1/members", b);
  }
  upsertProject(b: { slug: string; name?: string; repo_url?: string }) {
    return this.request<{ project: Me["projects"][number] }>("POST", "/v1/projects", b);
  }
  decisions(project?: string, timeoutMs?: number) {
    return this.request<{ seq: number; decisions: Decision[] }>("GET", `/v1/decisions${project ? `?project=${encodeURIComponent(project)}` : ""}`, undefined, timeoutMs);
  }
  decision(key: string) {
    return this.request<{ decision: Decision; upstream: string[]; downstream: string[] }>("GET", `/v1/decisions/${encodeURIComponent(key)}`);
  }
  revisions(key: string) {
    return this.request<{ revisions: Revision[] }>("GET", `/v1/decisions/${encodeURIComponent(key)}/revisions`);
  }
  create(input: unknown) {
    return this.request<{ decision: Decision; warnings: string[] }>("POST", "/v1/decisions", input);
  }
  update(key: string, patch: DecisionPatch) {
    return this.request<{ decision: Decision }>("PATCH", `/v1/decisions/${encodeURIComponent(key)}`, patch);
  }
  lint() {
    return this.request<{ issues: LintIssue[] }>("GET", "/v1/lint");
  }
  stats(days = 7) {
    return this.request<{ stats: Record<string, DecisionStats>; totals: { checks: number; blocked: number; violations: number } }>("GET", `/v1/stats?days=${days}`);
  }
  digest(days = 7) {
    return this.request<{ markdown: string }>("GET", `/v1/digest?days=${days}&format=json`);
  }
  reportChecks(checks: CheckEvent[], timeoutMs?: number) {
    return this.request<{ recorded: number }>("POST", "/v1/checks", { checks }, timeoutMs);
  }
}
