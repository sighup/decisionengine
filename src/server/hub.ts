import type { Db } from "./db.js";
import { NOTIFY_CHANNEL } from "./repo.js";

/**
 * Fans Postgres NOTIFY wake-ups out to in-process subscribers (SSE streams).
 * Because the signal goes through Postgres, every server instance behind a
 * load balancer hears every write.
 */
export class Hub {
  private subs = new Map<string, Set<() => void>>();
  private unlisten?: () => Promise<void>;

  constructor(private db: Db) {}

  async start(): Promise<void> {
    this.unlisten = await this.db.listen(NOTIFY_CHANNEL, (workspaceId) => {
      for (const fn of this.subs.get(workspaceId) ?? []) fn();
    });
  }

  subscribe(workspaceId: string, fn: () => void): () => void {
    let set = this.subs.get(workspaceId);
    if (!set) this.subs.set(workspaceId, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  async stop(): Promise<void> {
    await this.unlisten?.();
  }
}
