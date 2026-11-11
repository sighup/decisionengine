# DecisionEngine

A service plus CLI for capturing team decisions and enforcing them on coding agents. Read `docs/architecture.md` before changing storage, sync or enforcement.

## Layout

- `src/core/` pure domain logic shared by client and server: types, validation, graph, rule evaluation, check, rendering, markdown export
- `src/server/` the service: `db.ts` (pg + PGlite behind one interface), `schema.ts` (append-only migrations), `repo.ts` (data access + business rules), `hub.ts` (LISTEN/NOTIFY fan-out), `app.ts` (Hono routes + SSE), `main.ts`
- `src/client/` developer-machine side: `config.ts` (credentials, project link), `api.ts` (HTTP client), `cache.ts` (synced snapshot, telemetry outbox, SSE watcher), `session.ts`
- `src/agent/` Claude Code hooks and installers (`hooks.ts`), MCP server (`mcp.ts`)
- `src/ui/page.ts` the dashboard: one self-contained page, no build step, no external requests
- `src/cli.ts` commander entry point

## Rules of the codebase

- The service is the source of truth. Do not move decisions back into repository files; `.decisionengine.json` holds only the server URL and project slug.
- Enforcement stays deterministic and runs client-side against the snapshot. No LLM calls in `src/core/rules.ts`, `check.ts` or the hook path.
- Hooks fail open on internal errors; only a real violation blocks (exit 2).
- Never edit a shipped migration in `schema.ts`; append a new one.
- Every decision write goes through `Repo` so it gets a revision row and an `events` row with `pg_notify`.

## Commands

- `npm test` (embedded Postgres) and `TEST_DATABASE_URL=postgres://... npm test` (real Postgres)
- `npm run typecheck`, `npm run build`
