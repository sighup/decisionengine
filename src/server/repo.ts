import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DecisionGraph } from "../core/graph.js";
import type { CheckEvent, Decision, DecisionInput, DecisionPatch, DecisionStats, Revision, Status } from "../core/types.js";
import { STATUSES } from "../core/types.js";
import { formatKey, normalizeKey, validateInput, validateRules, ValidationError } from "../core/validate.js";
import type { Db, Queryable } from "./db.js";

export const NOTIFY_CHANNEL = "de_events";

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class ForbiddenError extends Error {}

export interface Workspace {
  id: string;
  name: string;
  key_prefix: string;
}

export interface Member {
  id: string;
  workspace_id: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member";
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  repo_url?: string | null;
}

export interface FeedEvent {
  seq: number;
  type: string;
  decision_key?: string | null;
  actor?: string | null;
  payload: any;
  created_at: string;
}

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const newToken = () => `de_${randomBytes(24).toString("base64url")}`;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? undefined : String(v));
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const json = (v: unknown) => JSON.stringify(v ?? []);

const DECISION_SELECT = `
  SELECT d.*, m.name AS author_name
  FROM decisions d LEFT JOIN members m ON m.id = d.author_id`;

function rowToDecision(r: any): Decision {
  return {
    id: r.key,
    title: r.title,
    status: r.status,
    date: day(r.decided_on),
    author: r.author_name ?? undefined,
    discipline: r.discipline ?? undefined,
    tags: r.tags ?? [],
    scope: r.scope ?? [],
    projects: r.projects ?? [],
    why: r.why ?? undefined,
    rejected: r.rejected ?? [],
    depends_on: r.depends_on ?? [],
    supersedes: r.supersedes ?? [],
    superseded_by: r.superseded_by ?? undefined,
    rules: r.rules ?? [],
    body: r.body ?? "",
    source: r.source ?? undefined,
    source_ref: r.source_ref ?? undefined,
    revision: r.revision,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

export class Repo {
  constructor(readonly db: Db) {}

  // ------------------------------------------------------------ identity

  async isEmpty(): Promise<boolean> {
    const [r] = await this.db.query(`SELECT count(*)::int AS n FROM workspaces`);
    return r.n === 0;
  }

  /** First-run bootstrap: create the workspace and its owner. Only allowed on an empty server. */
  async setup(input: { workspace: string; name: string; email: string; prefix?: string }) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx.query(`SELECT count(*)::int AS n FROM workspaces`);
      if (r.n > 0) throw new ConflictError("this server is already set up; ask an admin for an invite");
      const ws: Workspace = { id: randomUUID(), name: input.workspace, key_prefix: (input.prefix ?? "DEC").toUpperCase() };
      await tx.query(`INSERT INTO workspaces (id, name, key_prefix) VALUES ($1, $2, $3)`, [ws.id, ws.name, ws.key_prefix]);
      const member = await this.insertMember(tx, ws.id, { name: input.name, email: input.email, role: "owner" });
      const token = await this.insertToken(tx, member.id, "setup");
      return { workspace: ws, member, token };
    });
  }

  private async insertMember(tx: Queryable, workspaceId: string, m: { name: string; email: string; role: Member["role"] }): Promise<Member> {
    const id = randomUUID();
    try {
      await tx.query(`INSERT INTO members (id, workspace_id, name, email, role) VALUES ($1, $2, $3, $4, $5)`, [id, workspaceId, m.name, m.email.toLowerCase(), m.role]);
    } catch (e) {
      if (/unique|duplicate/i.test(String((e as Error).message))) throw new ConflictError(`a member with email ${m.email} already exists`);
      throw e;
    }
    return { id, workspace_id: workspaceId, name: m.name, email: m.email.toLowerCase(), role: m.role };
  }

  private async insertToken(tx: Queryable, memberId: string, label?: string): Promise<string> {
    const token = newToken();
    await tx.query(`INSERT INTO api_tokens (id, member_id, token_hash, label) VALUES ($1, $2, $3, $4)`, [randomUUID(), memberId, hashToken(token), label ?? null]);
    return token;
  }

  async authenticate(token: string): Promise<{ member: Member; workspace: Workspace } | undefined> {
    const rows = await this.db.query(
      `SELECT t.id AS token_id, t.last_used_at, m.id, m.workspace_id, m.name, m.email, m.role, w.name AS ws_name, w.key_prefix
       FROM api_tokens t JOIN members m ON m.id = t.member_id JOIN workspaces w ON w.id = m.workspace_id
       WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
      [hashToken(token)],
    );
    const r = rows[0];
    if (!r) return undefined;
    const last = r.last_used_at ? new Date(r.last_used_at).getTime() : 0;
    if (Date.now() - last > 60_000) await this.db.query(`UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, [r.token_id]);
    return {
      member: { id: r.id, workspace_id: r.workspace_id, name: r.name, email: r.email, role: r.role },
      workspace: { id: r.workspace_id, name: r.ws_name, key_prefix: r.key_prefix },
    };
  }

  async addMember(actor: Member, m: { name: string; email: string; role?: Member["role"] }) {
    if (actor.role === "member") throw new ForbiddenError("only owners and admins can invite members");
    const role = m.role ?? "member";
    if (role === "owner" && actor.role !== "owner") throw new ForbiddenError("only owners can add owners");
    return this.db.transaction(async (tx) => {
      const member = await this.insertMember(tx, actor.workspace_id, { name: m.name, email: m.email, role });
      const token = await this.insertToken(tx, member.id, "invite");
      return { member, token };
    });
  }

  async createToken(actor: Member, label?: string): Promise<string> {
    return this.insertToken(this.db, actor.id, label);
  }

  async revokeToken(token: string): Promise<void> {
    await this.db.query(`UPDATE api_tokens SET revoked_at = now() WHERE token_hash = $1`, [hashToken(token)]);
  }

  async listMembers(workspaceId: string): Promise<Member[]> {
    return this.db.query(`SELECT id, workspace_id, name, email, role FROM members WHERE workspace_id = $1 ORDER BY created_at`, [workspaceId]);
  }

  // ------------------------------------------------------------ projects

  async listProjects(workspaceId: string): Promise<Project[]> {
    return this.db.query(`SELECT id, slug, name, repo_url FROM projects WHERE workspace_id = $1 ORDER BY slug`, [workspaceId]);
  }

  async upsertProject(workspaceId: string, p: { slug: string; name?: string; repo_url?: string }): Promise<Project> {
    const slug = p.slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) throw new ValidationError("project slug is required");
    const rows = await this.db.query(
      `INSERT INTO projects (id, workspace_id, slug, name, repo_url) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, slug) DO UPDATE SET name = COALESCE($4, projects.name), repo_url = COALESCE($5, projects.repo_url)
       RETURNING id, slug, name, repo_url`,
      [randomUUID(), workspaceId, slug, p.name ?? slug, p.repo_url ?? null],
    );
    return rows[0];
  }

  private async projectId(workspaceId: string, slug?: string): Promise<string | null> {
    if (!slug) return null;
    const [r] = await this.db.query(`SELECT id FROM projects WHERE workspace_id = $1 AND slug = $2`, [workspaceId, slug]);
    return r?.id ?? null;
  }

  // ------------------------------------------------------------ decisions

  async listDecisions(workspaceId: string, opts: { project?: string } = {}): Promise<{ seq: number; decisions: Decision[] }> {
    const [s] = await this.db.query(`SELECT COALESCE(max(seq), 0)::int AS seq FROM events WHERE workspace_id = $1`, [workspaceId]);
    let decisions = (await this.db.query(`${DECISION_SELECT} WHERE d.workspace_id = $1 ORDER BY d.number`, [workspaceId])).map(rowToDecision);
    if (opts.project) decisions = decisions.filter((d) => !d.projects.length || d.projects.includes(opts.project!));
    return { seq: s.seq, decisions };
  }

  async getDecision(workspaceId: string, key: string): Promise<Decision> {
    const ws = await this.workspace(workspaceId);
    const rows = await this.db.query(`${DECISION_SELECT} WHERE d.workspace_id = $1 AND d.key = $2`, [workspaceId, normalizeKey(key, ws.key_prefix)]);
    if (!rows[0]) throw new NotFoundError(`no decision ${key}`);
    return rowToDecision(rows[0]);
  }

  async revisions(workspaceId: string, key: string): Promise<Revision[]> {
    const d = await this.getDecision(workspaceId, key);
    const rows = await this.db.query(
      `SELECT r.revision, r.note, r.snapshot, r.created_at, m.name AS author
       FROM decision_revisions r JOIN decisions d ON d.id = r.decision_id LEFT JOIN members m ON m.id = r.author_id
       WHERE d.workspace_id = $1 AND d.key = $2 ORDER BY r.revision`,
      [workspaceId, d.id],
    );
    return rows.map((r) => ({ revision: r.revision, note: r.note ?? undefined, author: r.author ?? undefined, created_at: iso(r.created_at)!, snapshot: r.snapshot }));
  }

  /** Pass `lock` inside a write transaction: it serialises writers per workspace. */
  private async workspace(id: string, tx: Queryable = this.db, lock = false): Promise<Workspace> {
    const [w] = await tx.query(`SELECT id, name, key_prefix FROM workspaces WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
    if (!w) throw new NotFoundError("workspace not found");
    return w;
  }

  private async loadAll(tx: Queryable, workspaceId: string): Promise<Decision[]> {
    return (await tx.query(`${DECISION_SELECT} WHERE d.workspace_id = $1 ORDER BY d.number`, [workspaceId])).map(rowToDecision);
  }

  private async writeRevision(tx: Queryable, workspaceId: string, key: string, actorId: string | null, note: string | undefined) {
    const [row] = await tx.query(`${DECISION_SELECT} WHERE d.workspace_id = $1 AND d.key = $2`, [workspaceId, key]);
    const snap = rowToDecision(row);
    await tx.query(`INSERT INTO decision_revisions (decision_id, revision, author_id, note, snapshot) VALUES ($1, $2, $3, $4, $5)`, [row.id, snap.revision, actorId, note ?? null, JSON.stringify(snap)]);
    return snap;
  }

  private async emit(tx: Queryable, workspaceId: string, type: string, key: string | null, actorId: string | null, payload: unknown) {
    await tx.query(`INSERT INTO events (workspace_id, type, decision_key, actor_id, payload) VALUES ($1, $2, $3, $4, $5)`, [workspaceId, type, key, actorId, JSON.stringify(payload ?? {})]);
    await tx.query(`SELECT pg_notify($1, $2)`, [NOTIFY_CHANNEL, workspaceId]);
  }

  /** Record a decision. Supersession of earlier decisions happens in the same transaction. */
  async createDecision(actor: Member, raw: unknown): Promise<{ decision: Decision; warnings: string[] }> {
    const input: DecisionInput = validateInput(raw);
    return this.db.transaction(async (tx) => {
      const ws = await this.workspace(actor.workspace_id, tx, true);
      const existing = await this.loadAll(tx, ws.id);
      const byKey = new Map(existing.map((d) => [d.id, d]));
      const fix = (k: string) => normalizeKey(k, ws.key_prefix);
      const depends = (input.depends_on ?? []).map(fix);
      const supersedes = (input.supersedes ?? []).map(fix);
      for (const k of [...depends, ...supersedes]) if (!byKey.has(k)) throw new ValidationError(`no decision ${k}`);
      for (const k of supersedes) {
        const old = byKey.get(k)!;
        if (old.status === "superseded") throw new ConflictError(`${k} is already superseded by ${old.superseded_by}`);
      }

      const [{ next_number: n }] = await tx.query(`UPDATE workspaces SET next_number = next_number + 1 WHERE id = $1 RETURNING next_number - 1 AS next_number`, [ws.id]);
      const key = formatKey(ws.key_prefix, n);
      await tx.query(
        `INSERT INTO decisions (id, workspace_id, key, number, title, status, decided_on, author_id, discipline, tags, scope, projects, why, rejected, depends_on, supersedes, rules, body, source, source_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          randomUUID(), ws.id, key, n, input.title, input.status ?? "accepted", input.date ?? new Date().toISOString().slice(0, 10), actor.id,
          input.discipline ?? null, json(input.tags), json(input.scope), json(input.projects), input.why ?? null, json(input.rejected),
          json(depends), json(supersedes), json(input.rules), input.body ?? "", input.source ?? null, input.source_ref ?? null,
        ],
      );
      const decision = await this.writeRevision(tx, ws.id, key, actor.id, "recorded");
      await this.emit(tx, ws.id, "decision.created", key, actor.id, { title: decision.title, status: decision.status });

      for (const k of supersedes) {
        await tx.query(
          `UPDATE decisions SET status = 'superseded', superseded_by = $3, revision = revision + 1, updated_at = now() WHERE workspace_id = $1 AND key = $2`,
          [ws.id, k, key],
        );
        await this.writeRevision(tx, ws.id, k, actor.id, `superseded by ${key}`);
        await this.emit(tx, ws.id, "decision.superseded", k, actor.id, { by: key });
      }

      const after = new DecisionGraph([
        ...existing.map((d) => (supersedes.includes(d.id) ? { ...d, status: "superseded" as const, superseded_by: key } : d)),
        decision,
      ]);
      const warnings = after.lint().filter((i) => i.id === key && i.level !== "info").map((i) => i.message);
      for (const k of supersedes) {
        const affected = new DecisionGraph(existing).downstream(k).map((d) => d.id);
        if (affected.length) warnings.push(`${affected.join(", ")} built on ${k}; re-examine them`);
      }
      return { decision, warnings };
    });
  }

  /** Edit a decision. Every change bumps the revision and is kept in history. */
  async updateDecision(actor: Member, rawKey: string, patch: DecisionPatch): Promise<Decision> {
    return this.db.transaction(async (tx) => {
      const ws = await this.workspace(actor.workspace_id, tx, true);
      const key = normalizeKey(rawKey, ws.key_prefix);
      const all = await this.loadAll(tx, ws.id);
      const cur = all.find((d) => d.id === key);
      if (!cur) throw new NotFoundError(`no decision ${key}`);

      const sets: string[] = [];
      const params: unknown[] = [ws.id, key];
      const set = (col: string, v: unknown) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      const next: Decision = { ...cur };
      if (patch.title !== undefined) {
        if (!String(patch.title).trim()) throw new ValidationError("title cannot be empty");
        set("title", (next.title = String(patch.title).trim()));
      }
      if (patch.status !== undefined) {
        if (!STATUSES.includes(patch.status as Status)) throw new ValidationError(`invalid status "${patch.status}"`);
        if (patch.status === "superseded") throw new ValidationError("record a new decision that supersedes this one instead");
        set("status", (next.status = patch.status as Status));
        if (cur.status === "superseded") set("superseded_by", null);
      }
      if (patch.why !== undefined) set("why", (next.why = patch.why || undefined) ?? null);
      if (patch.body !== undefined) set("body", (next.body = patch.body ?? ""));
      if (patch.discipline !== undefined) set("discipline", patch.discipline || null);
      if (patch.date !== undefined) set("decided_on", patch.date);
      if (patch.source_ref !== undefined) set("source_ref", patch.source_ref || null);
      for (const f of ["tags", "scope", "projects"] as const) if (patch[f] !== undefined) set(f, json((next[f] = patch[f] ?? [])));
      if (patch.rejected !== undefined) set("rejected", json((next.rejected = validateInput({ title: "x", rejected: patch.rejected }).rejected!)));
      if (patch.rules !== undefined) set("rules", json((next.rules = validateRules(patch.rules))));
      if (patch.depends_on !== undefined) {
        const deps = patch.depends_on.map((k) => normalizeKey(k, ws.key_prefix));
        for (const k of deps) if (!all.some((d) => d.id === k)) throw new ValidationError(`no decision ${k}`);
        next.depends_on = deps;
        const g = new DecisionGraph(all.map((d) => (d.id === key ? next : d)));
        if (g.lint().some((i) => i.message.startsWith("dependency cycle"))) throw new ValidationError("that would create a dependency cycle");
        set("depends_on", json(deps));
      }
      if (!sets.length) return cur;
      await tx.query(`UPDATE decisions SET ${sets.join(", ")}, revision = revision + 1, updated_at = now() WHERE workspace_id = $1 AND key = $2`, params);
      const decision = await this.writeRevision(tx, ws.id, key, actor.id, patch.note);
      await this.emit(tx, ws.id, "decision.updated", key, actor.id, { fields: Object.keys(patch).filter((k) => k !== "note"), note: patch.note });
      return decision;
    });
  }

  // ------------------------------------------------------------ enforcement telemetry

  async recordCheck(actor: Member, e: CheckEvent): Promise<void> {
    const projectId = await this.projectId(actor.workspace_id, e.project);
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO checks (workspace_id, project_id, member_id, source, agent, files, checked, violations, blocked, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, now()))`,
        [actor.workspace_id, projectId, actor.id, e.source, e.agent ?? null, json(e.files), json(e.checked), json(e.violations), !!e.blocked, e.ts ?? null],
      );
      if (e.violations.length) {
        await this.emit(tx, actor.workspace_id, "check.violation", null, actor.id, {
          project: e.project,
          agent: e.agent,
          source: e.source,
          blocked: e.blocked,
          violations: e.violations.slice(0, 20),
        });
      }
    });
  }

  async stats(workspaceId: string, since: Date): Promise<{ stats: Record<string, DecisionStats>; totals: { checks: number; blocked: number; violations: number } }> {
    const checked = await this.db.query(
      `SELECT k AS id, count(*)::int AS checks, max(c.created_at) AS last
       FROM checks c, jsonb_array_elements_text(c.checked) k
       WHERE c.workspace_id = $1 AND c.created_at >= $2 GROUP BY k`,
      [workspaceId, since.toISOString()],
    );
    const violated = await this.db.query(
      `SELECT v->>'id' AS id, count(DISTINCT c.id)::int AS violations, count(DISTINCT c.id) FILTER (WHERE c.blocked)::int AS blocked
       FROM checks c, jsonb_array_elements(c.violations) v
       WHERE c.workspace_id = $1 AND c.created_at >= $2 GROUP BY v->>'id'`,
      [workspaceId, since.toISOString()],
    );
    const [t] = await this.db.query(
      `SELECT count(*)::int AS checks, count(*) FILTER (WHERE blocked)::int AS blocked, COALESCE(sum(jsonb_array_length(violations)), 0)::int AS violations
       FROM checks WHERE workspace_id = $1 AND created_at >= $2`,
      [workspaceId, since.toISOString()],
    );
    const stats: Record<string, DecisionStats> = {};
    for (const r of checked) stats[r.id] = { checks: r.checks, violations: 0, blocked: 0, last_checked: iso(r.last) };
    for (const r of violated) {
      stats[r.id] ??= { checks: 0, violations: 0, blocked: 0 };
      stats[r.id].violations = r.violations;
      stats[r.id].blocked = r.blocked;
    }
    return { stats, totals: t };
  }

  async recentChecks(workspaceId: string, limit = 100) {
    const rows = await this.db.query(
      `SELECT c.source, c.agent, c.files, c.violations, c.blocked, c.created_at, m.name AS member, p.slug AS project
       FROM checks c LEFT JOIN members m ON m.id = c.member_id LEFT JOIN projects p ON p.id = c.project_id
       WHERE c.workspace_id = $1 ORDER BY c.id DESC LIMIT $2`,
      [workspaceId, limit],
    );
    return rows.map((r) => ({ ...r, created_at: iso(r.created_at) }));
  }

  async events(workspaceId: string, after: number, limit = 500): Promise<FeedEvent[]> {
    const rows = await this.db.query(
      `SELECT e.seq::int AS seq, e.type, e.decision_key, e.payload, e.created_at, m.name AS actor
       FROM events e LEFT JOIN members m ON m.id = e.actor_id
       WHERE e.workspace_id = $1 AND e.seq > $2 ORDER BY e.seq LIMIT $3`,
      [workspaceId, after, limit],
    );
    return rows.map((r) => ({ ...r, created_at: iso(r.created_at)! }));
  }
}
