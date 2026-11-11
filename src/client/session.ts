import { ApiClient } from "./api.js";
import { DecisionCache } from "./cache.js";
import { resolveContext, type ResolvedContext } from "./config.js";
import type { Decision } from "../core/types.js";

export class NotConfiguredError extends Error {}

/** Everything a command needs to talk to the service for the current repository. */
export class Session {
  readonly api: ApiClient;
  readonly cache: DecisionCache;

  constructor(readonly ctx: ResolvedContext & { server: string; token: string }) {
    this.api = new ApiClient(ctx.server, ctx.token);
    this.cache = new DecisionCache(this.api);
  }

  static open(start?: string): Session {
    const ctx = resolveContext(start);
    if (!ctx.server) throw new NotConfiguredError("No DecisionEngine server configured. Run `de login <server-url>` (or `de server` to run one locally).");
    if (!ctx.token) throw new NotConfiguredError(`Not signed in to ${ctx.server}. Run \`de login ${ctx.server}\`.`);
    return new Session(ctx as ResolvedContext & { server: string; token: string });
  }

  /** Session or undefined when not configured: for hooks, which must never fail. */
  static tryOpen(start?: string): Session | undefined {
    try {
      return Session.open(start);
    } catch {
      return undefined;
    }
  }

  /** Decisions that apply to this repository's project (workspace-wide ones included). */
  forProject(decisions: Decision[]): Decision[] {
    const p = this.ctx.project;
    return p ? decisions.filter((d) => !d.projects.length || d.projects.includes(p)) : decisions;
  }
}
