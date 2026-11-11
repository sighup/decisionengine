# Architecture

DecisionEngine has three parts: a **service** that is the source of truth, **clients** that run on developer machines and in CI, and **agent integrations** that sit inside coding agents.

```
             ┌──────────────────────── DecisionEngine service ────────────────────────┐
             │  HTTP API (/v1)   SSE change feed (/v1/stream)   Dashboard (/)         │
             │        └────────────── Repo (data access) ──────────────┘             │
             │                         Postgres                                       │
             │   decisions · decision_revisions · events · checks · members · tokens  │
             └───────────────▲──────────────────────▲──────────────────▲─────────────┘
                     REST    │            SSE        │          REST    │
             ┌───────────────┴───────┐   ┌──────────┴─────────┐   ┌────┴──────────────┐
             │ de CLI (new, check…)  │   │ MCP server / watch │   │ CI: de check      │
             └───────────┬───────────┘   └──────────┬─────────┘   └───────────────────┘
                         │      local snapshot      │
                         └──────► ~/.cache/decisionengine ◄────── Claude Code hooks
```

## Decisions that shaped it

**The service is the source of truth, not files in the repository.** Decisions are made in agent sessions, threads and meetings, often across several repositories and disciplines (a business call shapes a product rule which shapes an auth choice). A shared service lets one decision reach every teammate's agents within seconds, keeps one graph across projects, and records enforcement as it happens. Rejected: Markdown files in each repo. They are easy to start with, but sharing waits on merges, the graph fragments per repo, and business or design decisions have no natural home. Decisions remain exportable (`de export`) so there is no lock-in.

**Postgres, with an append-only revision history.** Every create or edit writes a full snapshot to `decision_revisions` so "what did we believe in March, and who changed it?" is always answerable. An ordered `events` table is the change feed; `pg_notify` wakes every server instance, so the service scales horizontally behind a load balancer. The same SQL runs on embedded Postgres (PGlite) for single-machine use and tests.

**Enforcement is deterministic and local.** Rules are regexes, dependency manifests and globs. They are evaluated on the developer's machine against a synced snapshot, so a hook answers in milliseconds and gives the same answer every time. Rejected: asking an LLM whether a change violates a decision (probabilistic, slow, costly per edit) and server-side evaluation on every edit (network latency inside every agent action).

**Fail open.** If the service is unreachable, hooks enforce the last snapshot and queue telemetry for later. If DecisionEngine itself errors, the agent is never blocked. Only a real violation blocks. CI (`de check`) is the exception: it requires a fresh copy from the service, because it is the final gate.

**Only added lines are checked.** Existing code never blocks new work; a decision governs what happens after it was made.

## Data model

| Table | Purpose |
|---|---|
| `workspaces` | A team or company. Owns the decision key sequence (`DEC-001`, ...). |
| `members`, `api_tokens` | People and their hashed tokens (`owner`, `admin`, `member`). |
| `projects` | Repositories linked with `de init`. Decisions can be limited to projects. |
| `decisions` | Current state of each decision, including rules and links (`depends_on`, `supersedes`). |
| `decision_revisions` | Immutable snapshot per revision, with author and note. |
| `events` | Ordered change feed (`decision.created`, `decision.updated`, `decision.superseded`, `check.violation`). |
| `checks` | Enforcement telemetry: who checked what, which decisions applied, what was blocked. |

## Real-time path

1. A write commits a row in `events` and calls `pg_notify('de_events', workspace_id)` in the same transaction.
2. Every server instance `LISTEN`s, and wakes the SSE streams for that workspace.
3. Each stream sends the events after its cursor, using the event `seq` as the SSE id, so clients resume losslessly with `Last-Event-ID`.
4. Clients (the MCP server, `de watch`, the dashboard) refetch the decision set and update their local snapshot. Hooks read the snapshot.
