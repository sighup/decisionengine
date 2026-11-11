# DecisionEngine

**Capture your team's decisions as you make them, and hold every coding agent to them.**

Teams settle questions every day: sessions over JWTs, Postgres over Mongo, "call it Members, not Users". Those calls live in someone's head, a Slack thread or a stale wiki page. Coding agents don't know about them, so they cheerfully put JWTs back, and you find out at code review if you're lucky.

DecisionEngine is a shared service that turns each settled decision into a durable record (what was chosen, why, what was rejected, where it applies, what it builds on) and enforces it:

- **Durable.** Decisions outlive the session that made them, with a full revision history of who changed what and why.
- **Networked.** A decision recorded by one teammate (or their agent) reaches every other teammate's agents within seconds over a live feed. Decisions form one graph across projects and disciplines, so changing one shows everything downstream.
- **Enforced.** Decisions can carry deterministic rules. Agent edits that break them are blocked before they are written, and CI catches anything that slips through. No LLM judgement in the enforcement path: the same change always gets the same answer.

```
$ de new "Sessions over JWTs" \
    --why "Revocation must be instant; token expiry windows failed the security review." \
    --reject "JWT bearer tokens: stateless, but a stolen token can't be killed" \
    --scope 'src/auth/**' --forbid-dep jsonwebtoken --forbid 'jwt\.sign'
Recorded DEC-002 Sessions over JWTs  shared with your team
```

Moments later, on a teammate's machine, their agent tries `npm i jsonwebtoken`:

```
DecisionEngine blocked this Bash call.

DEC-002: Sessions over JWTs
  Why: Revocation must be instant; token expiry windows failed the security review.
  Rejected: JWT bearer tokens
  ✗ package.json:1 adds forbidden dependency "jsonwebtoken"
  1 downstream decision(s) depend on this: DEC-004

Do not retry the same change. Either adjust the approach to respect the decision,
or explain the conflict to the user and ask whether to supersede it.
```

## Quick start

Requires Node 20+.

```sh
npm install -g github:sighup/decisionengine

# 1. Run the service (embedded Postgres; see "Deploying" for production)
de server

# 2. Create your workspace and sign in (once)
de setup http://localhost:4477 --workspace "Acme" --name "Your Name" --email you@example.com

# 3. In each repository: link it and wire up Claude Code
cd your-repo
de init --claude --git-hook

# 4. Invite teammates; each runs the printed `de login` command
de invite --name "Dana" --email dana@example.com
```

`de init` writes `.decisionengine.json` (just the server URL and project name, no decisions) and, with `--claude`, adds hooks to `.claude/settings.json` (enforcement, context and capture) and the MCP server to `.mcp.json`. Commit those files so every teammate's agent is connected.

## How agents use it

| Moment | What happens |
|---|---|
| Session starts | A `SessionStart` hook injects a one-line summary of every settled decision for this project. |
| Before editing | The agent calls `decisions_for_paths` (MCP) to read the full rationale for the files it will touch. |
| Every `Write` / `Edit` / `MultiEdit` | A `PreToolUse` hook checks only the lines being added. A violation blocks the edit and tells the agent why. |
| Every `npm i` / `pip install` / `cargo add` / `go get` | The same hook catches forbidden dependencies before they are installed. |
| The user settles a choice | The agent records it with `record_decision`, including rejected options. Every teammate's agent has it within seconds. |
| Every few turns | The plugin asks a fork of the session what was settled. Anything not yet recorded becomes a proposal, shown above the prompt to accept or reject. (Without the plugin, `Stop`/`SessionEnd` hooks do the same with `claude -p`.) |
| A teammate decides something | The MCP server's live feed updates the local snapshot, so the next hook already enforces it. |
| Commit / pull request | `de check --staged` (pre-commit) and `de check --base origin/main` (CI) are the final gate. |

Any MCP client (Cursor, Windsurf, Codex, Claude Desktop) can use `de mcp` over stdio.

| MCP tool | Purpose |
|---|---|
| `decisions_for_paths` | Decisions governing a set of files, with rationale and rejected options |
| `list_decisions` | Filter by status, tag or free-text search |
| `get_decision` | One decision with what it builds on, what depends on it, and enforcement stats |
| `record_decision` | Capture a decision (optionally superseding earlier ones), shared immediately |
| `check_change` | Check proposed file contents before writing them |
| `check_working_tree` | Check uncommitted changes, or a branch against its base |
| `decision_digest` | What the team decided, reversed and enforced recently |

## Automatic capture

Most decisions are settled in conversation and never written down. DecisionEngine finds them for you, using the Claude you already have: **no API key is needed anywhere.**

- **In Claude Code.** The DecisionEngine plugin asks a fork of your own session, every few turns, which choices were actually settled, with the reasoning and the options turned down. The conversation is already in the prompt cache, so this mostly reads cached tokens, and it runs in the background. Proposals appear above the prompt with **Accept** and **Reject**; `/capture-decisions` asks right away.
- **From history.** `de capture --from-git` reads the repository's commit history to reconstruct decisions made before you started; `--since`, `--limit` and `--range` narrow it.
- **From notes.** `de capture --notes meeting.md` (or `-` for stdin) does the same for meeting notes, Slack exports, RFCs and design docs.

Install the plugin in Claude Code (`de init --claude` also declares it in the repository's `.claude/settings.json`, so teammates are offered it when they open the project):

```
/plugin install decisionengine --marketplace sighup/decisionengine
```

Every captured decision arrives as **proposed**, linked to where it came from with a quote as evidence. Nothing is enforced and nothing is superseded until someone accepts it, in the session, in the dashboard's review inbox or with `de accept`. Duplicates of existing decisions, and proposals someone already rejected, are skipped. The service validates everything a client extracts before recording it.

Who runs the model:

| Where | Model | Billed to |
|---|---|---|
| Claude Code with the plugin | a fork of the developer's session | the developer's Claude sign-in |
| Claude Code without the plugin, `de capture` | `claude -p` on the developer's machine (no tools, outside the repo) | the developer's Claude sign-in |
| Any of the above, if the service has `ANTHROPIC_API_KEY` | the service's extractor (except the plugin, which always forks) | the service's key |

Only what the developer and agent said is read, never tool output or file contents, and common credential formats are redacted before anything leaves the machine. To turn capture off for a repository, run `de install claude-code --no-capture`; for one developer, set `DE_CAPTURE=off`. Enforcement never uses a model.

### Speed and failure modes

Hooks never wait on the network when they don't have to. The CLI and MCP server keep a snapshot in `~/.cache/decisionengine/`, updated live from the service's feed. If the service is unreachable, hooks enforce the last snapshot and queue their telemetry until it's back. If DecisionEngine itself fails, the agent is not blocked; only a real violation blocks. `de check` in CI always fetches the current decisions, because it is the final gate.

## Decisions

A decision has a title, a rationale (`why`), rejected options, optional `scope` globs (paths it governs), optional `projects` (omit for workspace-wide), links (`depends_on`, `supersedes`) and optional rules. Statuses are `proposed`, `accepted`, `superseded` and `deprecated`; only `accepted` decisions are enforced. Decisions without rules are advisory: agents see them as context, but nothing is checked mechanically.

| Rule | Fields | Blocks |
|---|---|---|
| `forbid_pattern` | `pattern`, `flags?`, `paths?` | Added lines matching a regex. `paths` defaults to the decision's scope. |
| `require_pattern` | `pattern`, `flags?`, `paths` | Touched files that don't contain the regex (e.g. a license header). |
| `forbid_dependency` | `packages` | Adding a package to `package.json`, `requirements*.txt`, `pyproject.toml`, `Pipfile`, `go.mod`, `Cargo.toml` or `Gemfile`, or installing it from the shell. |
| `forbid_path` | `paths` | Creating or changing files matching the globs. |

Only *added* lines are checked, so existing code never blocks new work. To exempt one line, add a `de-allow DEC-002` comment to it.

## Commands

```
de server [--database-url <url>]      run the service (API, live feed, dashboard)
de setup <url> --workspace --name --email
de login [url] [--token]  ·  de logout  ·  de whoami
de invite --name --email [--role]     add a teammate (prints their token once)
de init [--claude] [--git-hook]       link this repo to a project, install hooks

de new <title> [options]              record a decision (alias: de decide)
de supersede <id> <title>             replace a decision; flags everything downstream
de edit <id> [--why --scope --add-rule <json> --note ...]
de accept | deprecate | propose <id>
de list  ·  de show <id> [--history]  ·  de context [paths...]

de check [paths...] [--staged | --base <ref>]
de lint                               broken links, cycles, stale dependencies, conflicting rules
de digest [--days 7]                  decided, reversed, enforced: the standup you can skip
de watch                              follow the team's decisions live
de ui                                 open the dashboard, signed in
de capture --from-git | --notes <file> [--local]   find decisions in history or notes, as proposals
de import-adr <dir>                   import existing ADRs (Nygard or MADR)
de export [--format markdown|json]    everything, any time
de mcp  ·  de hook <event>            agent entry points
```

`de new` options: `--why`, `--reject "option: reason"` (repeatable), `--tag`, `--scope <glob>`, `--depends <id>`, `--supersedes <id>`, `--project-only`, `--discipline`, `--status proposed`, `--ref <url>`, and rule shortcuts `--forbid <regex>`, `--require <regex>`, `--forbid-dep <pkg>`, `--forbid-path <glob>`, `--message`.

## Dashboard

The service serves a dashboard at its root URL (`de ui` opens it signed in). It shows the decision log with rationale, rejected options and history; the dependency graph; enforcement activity across the team; and graph health. It updates live as teammates and their agents record decisions or trip rules. Captured proposals wait in a review inbox, each with its evidence and source, to be accepted or rejected.

## Deploying

The service is one Node process plus Postgres.

```sh
docker compose up -d     # service on :4477 with Postgres 16
```

Capture needs nothing on the service: developers' own Claude does the reading. Optionally set `ANTHROPIC_API_KEY` there to have the service extract for clients without Claude Code. Or run `de server` anywhere with `DATABASE_URL` set (Postgres 14+). Migrations run automatically on start. Multiple instances can run behind a load balancer: real-time fan-out goes through Postgres `LISTEN/NOTIFY`. Put TLS in front of it (any reverse proxy). Without `DATABASE_URL`, `de server` uses embedded Postgres in `~/.local/share/decisionengine`, which suits a single machine or a trial.

## CI

See [`examples/github-action.yml`](examples/github-action.yml): `de check --base origin/main` checks only what the pull request adds and exits non-zero on violations.

## Design

See [`docs/architecture.md`](docs/architecture.md) for the data model, the real-time path and the decisions behind them.

## Roadmap

- Sign-in with GitHub/Google and SSO in place of pasted tokens
- Capture straight from Slack, pull request discussions and docs (today: paste or export them into `de capture --notes`)
- Conflict detection between in-flight branches and between teammates' pending work
- More rule types (AST-aware imports, API surface, file ownership)
- Hosted offering

## Development

```sh
npm install
npm test                    # embedded Postgres
TEST_DATABASE_URL=postgres://user:pass@localhost/db npm test   # real Postgres
npm run typecheck && npm run build
npm run dev -- server       # run from source
```

MIT licensed.
