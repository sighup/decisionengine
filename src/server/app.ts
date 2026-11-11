import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { DecisionGraph } from "../core/graph.js";
import { digestMarkdown } from "../core/render.js";
import { ValidationError } from "../core/validate.js";
import { PAGE } from "../ui/page.js";
import { VERSION } from "../version.js";
import { CAPTURE_SOURCES, MAX_CAPTURE_CHARS } from "../core/capture.js";
import type { Extractor } from "./extract.js";
import type { Hub } from "./hub.js";
import { ConflictError, ForbiddenError, NotFoundError, type Member, type Repo, type Workspace } from "./repo.js";

type Env = { Variables: { member: Member; workspace: Workspace } };

const days = (c: Context, def = 7) => {
  const n = Number(c.req.query("days") ?? def);
  return new Date(Date.now() - (Number.isFinite(n) && n > 0 ? n : def) * 864e5);
};

export function createApp(repo: Repo, hub: Hub, opts: { heartbeatMs?: number; extractor?: Extractor } = {}) {
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    if (err instanceof ForbiddenError) return c.json({ error: err.message }, 403);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
    if (err instanceof SyntaxError) return c.json({ error: "invalid JSON body" }, 400);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/", (c) => c.html(PAGE));
  app.get("/healthz", async (c) => c.json({ ok: true, version: VERSION, setup_required: await repo.isEmpty() }));

  app.post("/v1/setup", async (c) => {
    const b = await c.req.json();
    for (const f of ["workspace", "name", "email"]) if (!b?.[f]) throw new ValidationError(`${f} is required`);
    const out = await repo.setup(b);
    return c.json(out, 201);
  });

  // Everything below requires a token: "Authorization: Bearer de_..." (or ?access_token= for browser streams).
  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization");
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1] ?? c.req.query("access_token");
    const auth = token ? await repo.authenticate(token) : undefined;
    if (!auth) return c.json({ error: "missing or invalid token" }, 401);
    c.set("member", auth.member);
    c.set("workspace", auth.workspace);
    await next();
  });

  app.get("/v1/me", async (c) => {
    const ws = c.get("workspace");
    return c.json({ member: c.get("member"), workspace: ws, projects: await repo.listProjects(ws.id) });
  });

  app.get("/v1/members", async (c) => c.json({ members: await repo.listMembers(c.get("workspace").id) }));
  app.post("/v1/members", async (c) => c.json(await repo.addMember(c.get("member"), await c.req.json()), 201));
  app.post("/v1/tokens", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    return c.json({ token: await repo.createToken(c.get("member"), b?.label) }, 201);
  });
  app.delete("/v1/tokens/current", async (c) => {
    const token = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (token) await repo.revokeToken(token);
    return c.body(null, 204);
  });

  app.get("/v1/projects", async (c) => c.json({ projects: await repo.listProjects(c.get("workspace").id) }));
  app.post("/v1/projects", async (c) => c.json({ project: await repo.upsertProject(c.get("workspace").id, await c.req.json()) }, 201));

  app.get("/v1/decisions", async (c) => c.json(await repo.listDecisions(c.get("workspace").id, { project: c.req.query("project") })));
  app.post("/v1/decisions", async (c) => c.json(await repo.createDecision(c.get("member"), await c.req.json()), 201));
  app.get("/v1/decisions/:key", async (c) => {
    const ws = c.get("workspace").id;
    const decision = await repo.getDecision(ws, c.req.param("key"));
    const { decisions } = await repo.listDecisions(ws);
    const g = new DecisionGraph(decisions);
    return c.json({ decision, upstream: g.upstreamClosure(decision.id), downstream: g.downstreamClosure([decision.id]) });
  });
  app.patch("/v1/decisions/:key", async (c) => c.json({ decision: await repo.updateDecision(c.get("member"), c.req.param("key"), await c.req.json()) }));
  app.get("/v1/decisions/:key/revisions", async (c) => c.json({ revisions: await repo.revisions(c.get("workspace").id, c.req.param("key")) }));

  // Capture: turn a session transcript, commit history or notes into *proposed* decisions.
  app.get("/v1/capture", (c) => c.json({ enabled: !!opts.extractor, max_chars: MAX_CAPTURE_CHARS }));
  app.post("/v1/capture", async (c) => {
    if (!opts.extractor) return c.json({ error: "capture is not enabled on this server (set ANTHROPIC_API_KEY)" }, 501);
    const b = await c.req.json();
    if (!CAPTURE_SOURCES.includes(b?.source)) throw new ValidationError(`source must be one of ${CAPTURE_SOURCES.join(", ")}`);
    if (typeof b.text !== "string" || !b.text.trim()) throw new ValidationError("text is required");
    if (b.text.length > MAX_CAPTURE_CHARS) return c.json({ error: `text exceeds ${MAX_CAPTURE_CHARS} characters; split it` }, 413);
    const ws = c.get("workspace").id;
    const { decisions: existing } = await repo.listDecisions(ws);
    const proposals = await opts.extractor.extract({ source: b.source, text: b.text, existing });
    const created = await repo.createProposals(c.get("member"), proposals, {
      source: b.source,
      source_ref: typeof b.source_ref === "string" ? b.source_ref : undefined,
      project: typeof b.project === "string" && b.project ? b.project : undefined,
    });
    return c.json({ proposals: created }, 201);
  });

  app.get("/v1/lint", async (c) => {
    const { decisions } = await repo.listDecisions(c.get("workspace").id);
    return c.json({ issues: new DecisionGraph(decisions).lint() });
  });

  app.post("/v1/checks", async (c) => {
    const b = await c.req.json();
    const events = Array.isArray(b?.checks) ? b.checks : [b];
    for (const e of events) {
      if (!e || !["cli", "hook", "mcp", "ci"].includes(e.source)) throw new ValidationError("source must be cli, hook, mcp or ci");
      if (!Array.isArray(e.files) || !Array.isArray(e.checked) || !Array.isArray(e.violations)) throw new ValidationError("files, checked and violations are required arrays");
      await repo.recordCheck(c.get("member"), e);
    }
    return c.json({ recorded: events.length }, 201);
  });
  app.get("/v1/checks", async (c) => c.json({ checks: await repo.recentChecks(c.get("workspace").id, Math.min(Number(c.req.query("limit") ?? 100), 500)) }));
  app.get("/v1/stats", async (c) => c.json(await repo.stats(c.get("workspace").id, days(c))));

  app.get("/v1/digest", async (c) => {
    const ws = c.get("workspace").id;
    const since = days(c);
    const [{ decisions }, st] = await Promise.all([repo.listDecisions(ws), repo.stats(ws, since)]);
    const markdown = digestMarkdown({ decisions, ...st, since });
    return c.req.query("format") === "json" ? c.json({ markdown }) : c.text(markdown);
  });

  app.get("/v1/events", async (c) => c.json({ events: await repo.events(c.get("workspace").id, Number(c.req.query("after") ?? 0)) }));

  /** Live change feed. Resumes from Last-Event-ID (or ?after=). */
  app.get("/v1/stream", (c) => {
    const ws = c.get("workspace").id;
    let cursor = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? -1);
    return streamSSE(c, async (stream) => {
      if (cursor < 0) {
        const { seq } = await repo.listDecisions(ws);
        cursor = seq;
      }
      let wake: (() => void) | undefined;
      let pending = true;
      const unsubscribe = hub.subscribe(ws, () => {
        pending = true;
        wake?.();
      });
      stream.onAbort(() => {
        unsubscribe();
        wake?.();
      });
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ seq: cursor }) });
      const heartbeat = opts.heartbeatMs ?? 25_000;
      while (!stream.aborted) {
        if (pending) {
          pending = false;
          for (const e of await repo.events(ws, cursor)) {
            await stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });
            cursor = e.seq;
          }
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, heartbeat);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        wake = undefined;
        if (!pending && !stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" });
      }
      unsubscribe();
    });
  });

  return app;
}
