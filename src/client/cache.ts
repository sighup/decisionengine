import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckEvent, Decision } from "../core/types.js";
import { ApiClient, ApiError } from "./api.js";
import { cacheDir } from "./config.js";

/**
 * A live-synced, on-disk snapshot of a workspace's decisions.
 *
 * Hooks run on every agent edit and must answer in milliseconds, even when the
 * service is slow or unreachable. They read this snapshot; a background watcher
 * (the MCP server or `de watch`) keeps it current from the service's SSE feed,
 * and short-lived processes refresh it when it is older than `maxAgeMs`.
 */
export interface Snapshot {
  server: string;
  seq: number;
  /** When the snapshot was last confirmed current (fetch, stream event or heartbeat). */
  fresh_at: number;
  decisions: Decision[];
}

const keyFor = (server: string, token: string) => createHash("sha256").update(`${server}\n${token}`).digest("hex").slice(0, 16);

export class DecisionCache {
  readonly file: string;
  readonly outbox: string;

  constructor(readonly api: ApiClient) {
    const dir = cacheDir();
    mkdirSync(dir, { recursive: true });
    const k = keyFor(api.server, api.token ?? "");
    this.file = join(dir, `${k}.json`);
    this.outbox = join(dir, `${k}.outbox.jsonl`);
  }

  read(): Snapshot | undefined {
    try {
      return JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return undefined;
    }
  }

  write(s: Omit<Snapshot, "server">) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ server: this.api.server, ...s }));
    renameSync(tmp, this.file); // atomic: concurrent hooks never see a half-written file
  }

  touch() {
    const s = this.read();
    if (s) this.write({ ...s, fresh_at: Date.now() });
  }

  async refresh(timeoutMs = 10_000): Promise<Snapshot> {
    const { seq, decisions } = await this.api.decisions(undefined, timeoutMs);
    const snap = { seq, decisions, fresh_at: Date.now() };
    this.write(snap);
    return { server: this.api.server, ...snap };
  }

  /**
   * Decisions for enforcement. Uses the snapshot when fresh, otherwise tries the
   * service within `timeoutMs` and falls back to the stale snapshot (fail open).
   */
  async get(opts: { maxAgeMs?: number; timeoutMs?: number } = {}): Promise<{ decisions: Decision[]; stale: boolean; source: "cache" | "live" | "none" }> {
    const maxAge = opts.maxAgeMs ?? 15_000;
    const cached = this.read();
    if (cached && Date.now() - cached.fresh_at < maxAge) return { decisions: cached.decisions, stale: false, source: "cache" };
    try {
      const s = await this.refresh(opts.timeoutMs ?? 1_500);
      return { decisions: s.decisions, stale: false, source: "live" };
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) throw e;
      return cached ? { decisions: cached.decisions, stale: true, source: "cache" } : { decisions: [], stale: true, source: "none" };
    }
  }

  /** Report check telemetry; queue it locally if the service is unreachable and flush later. */
  async report(event: CheckEvent, timeoutMs = 1_500): Promise<void> {
    const queued = this.drainOutbox();
    const batch = [...queued, { ...event, ts: event.ts ?? new Date().toISOString() }];
    try {
      await this.api.reportChecks(batch, timeoutMs);
    } catch {
      try {
        appendFileSync(this.outbox, batch.map((e) => JSON.stringify(e)).join("\n") + "\n");
      } catch {
        /* telemetry is best effort */
      }
    }
  }

  private drainOutbox(): CheckEvent[] {
    if (!existsSync(this.outbox)) return [];
    const claimed = `${this.outbox}.${process.pid}`;
    try {
      renameSync(this.outbox, claimed);
    } catch {
      return [];
    }
    try {
      return readFileSync(claimed, "utf8")
        .split("\n")
        .filter(Boolean)
        .slice(-500)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    } finally {
      try {
        unlinkSync(claimed);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Follow the service's SSE feed and keep the cache current. Reconnects with
 * backoff and resumes from the last event id. Returns a stop function.
 */
export function watch(cache: DecisionCache, onChange?: (e: { type: string; data: any }) => void): () => void {
  let stopped = false;
  let controller: AbortController | undefined;
  let lastId: string | undefined;

  const loop = async () => {
    let backoff = 1_000;
    while (!stopped) {
      controller = new AbortController();
      try {
        const snap = await cache.refresh();
        lastId ??= String(snap.seq);
        const res = await fetch(`${cache.api.server}/v1/stream`, {
          headers: { authorization: `Bearer ${cache.api.token}`, accept: "text/event-stream", ...(lastId ? { "last-event-id": lastId } : {}) },
          signal: controller.signal,
        });
        if (res.status === 401) throw new ApiError("invalid token", 401);
        if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
        backoff = 1_000;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = parseSse(raw);
            if (!ev) continue;
            if (ev.id) lastId = ev.id;
            if (ev.event.startsWith("decision.")) {
              await cache.refresh().catch(() => {});
              onChange?.({ type: ev.event, data: safeJson(ev.data) });
            } else if (ev.event === "ping" || ev.event === "ready") {
              cache.touch();
            } else {
              onChange?.({ type: ev.event, data: safeJson(ev.data) });
            }
          }
        }
      } catch (e) {
        if (stopped) return;
        if (e instanceof ApiError && e.status === 401) return;
      }
      if (stopped) return;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  };
  void loop();
  return () => {
    stopped = true;
    controller?.abort();
  };
}

function parseSse(raw: string): { id?: string; event: string; data: string } | undefined {
  let id: string | undefined;
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length || id ? { id, event, data: data.join("\n") } : undefined;
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
