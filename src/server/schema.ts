/**
 * Ordered, append-only migrations. Never edit a shipped migration; add a new one.
 */
export const MIGRATIONS: string[] = [
  `
CREATE TABLE workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  key_prefix text NOT NULL DEFAULT 'DEC',
  next_number int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE members (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email)
);

CREATE TABLE api_tokens (
  id text PRIMARY KEY,
  member_id text NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE projects (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  repo_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, slug)
);

CREATE TABLE decisions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  number int NOT NULL,
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('proposed', 'accepted', 'superseded', 'deprecated')),
  decided_on date NOT NULL,
  author_id text REFERENCES members(id) ON DELETE SET NULL,
  discipline text,
  tags jsonb NOT NULL DEFAULT '[]',
  scope jsonb NOT NULL DEFAULT '[]',
  projects jsonb NOT NULL DEFAULT '[]',
  why text,
  rejected jsonb NOT NULL DEFAULT '[]',
  depends_on jsonb NOT NULL DEFAULT '[]',
  supersedes jsonb NOT NULL DEFAULT '[]',
  superseded_by text,
  rules jsonb NOT NULL DEFAULT '[]',
  body text NOT NULL DEFAULT '',
  source text,
  source_ref text,
  revision int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, key),
  UNIQUE (workspace_id, number)
);

CREATE TABLE decision_revisions (
  decision_id text NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  revision int NOT NULL,
  author_id text REFERENCES members(id) ON DELETE SET NULL,
  note text,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (decision_id, revision)
);

-- Ordered change feed. seq is the cursor clients resume from.
CREATE TABLE events (
  seq bigserial PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type text NOT NULL,
  decision_key text,
  actor_id text REFERENCES members(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_workspace_seq ON events (workspace_id, seq);

CREATE TABLE checks (
  id bigserial PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id text REFERENCES projects(id) ON DELETE SET NULL,
  member_id text REFERENCES members(id) ON DELETE SET NULL,
  source text NOT NULL,
  agent text,
  files jsonb NOT NULL DEFAULT '[]',
  checked jsonb NOT NULL DEFAULT '[]',
  violations jsonb NOT NULL DEFAULT '[]',
  blocked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checks_workspace_time ON checks (workspace_id, created_at);
`,
];
