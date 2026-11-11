import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Where things live on a developer machine:
 *  - credentials: ~/.config/decisionengine/credentials.json (per server; never in the repo)
 *  - project link: <repo>/.decisionengine.json (server URL + project slug; safe to commit, holds no decisions)
 *  - cache:       ~/.cache/decisionengine/ (live-synced snapshot used by hooks)
 */

export const LINK_FILE = ".decisionengine.json";

export interface ProjectLink {
  server: string;
  project: string;
}

interface Credentials {
  default?: string;
  servers: Record<string, { token: string; workspace?: string; member?: string }>;
}

const configDir = () => process.env.DE_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "decisionengine");
export const cacheDir = () => process.env.DE_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "decisionengine");
const credentialsFile = () => join(configDir(), "credentials.json");

export const normalizeServer = (url: string) => url.trim().replace(/\/+$/, "");

function readCredentials(): Credentials {
  try {
    return JSON.parse(readFileSync(credentialsFile(), "utf8"));
  } catch {
    return { servers: {} };
  }
}

export function saveCredentials(server: string, entry: { token: string; workspace?: string; member?: string }, makeDefault = true) {
  const creds = readCredentials();
  const url = normalizeServer(server);
  creds.servers[url] = entry;
  if (makeDefault || !creds.default) creds.default = url;
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(credentialsFile(), JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  chmodSync(credentialsFile(), 0o600);
}

export function removeCredentials(server: string) {
  const creds = readCredentials();
  delete creds.servers[normalizeServer(server)];
  if (creds.default === normalizeServer(server)) creds.default = Object.keys(creds.servers)[0];
  if (existsSync(credentialsFile())) writeFileSync(credentialsFile(), JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
}

/** Walk up from `start` to the directory holding the project link, else the git root, else `start`. */
export function findProjectRoot(start = process.cwd()): string {
  let dir = resolve(start);
  let gitRoot: string | undefined;
  for (;;) {
    if (existsSync(join(dir, LINK_FILE))) return dir;
    if (!gitRoot && existsSync(join(dir, ".git"))) gitRoot = dir;
    const parent = dirname(dir);
    if (parent === dir) return gitRoot ?? resolve(start);
    dir = parent;
  }
}

export function readLink(root: string): ProjectLink | undefined {
  try {
    const l = JSON.parse(readFileSync(join(root, LINK_FILE), "utf8"));
    return l?.server && l?.project ? { server: normalizeServer(l.server), project: String(l.project) } : undefined;
  } catch {
    return undefined;
  }
}

export function writeLink(root: string, link: ProjectLink) {
  writeFileSync(join(root, LINK_FILE), JSON.stringify({ server: normalizeServer(link.server), project: link.project }, null, 2) + "\n");
}

export interface ResolvedContext {
  root: string;
  server?: string;
  token?: string;
  project?: string;
  linked: boolean;
}

/** Combine env vars, the repo's project link and stored credentials. Env wins. */
export function resolveContext(start = process.cwd()): ResolvedContext {
  const root = findProjectRoot(start);
  const link = readLink(root);
  const creds = readCredentials();
  const server = normalizeServer(process.env.DE_SERVER ?? link?.server ?? creds.default ?? "") || undefined;
  const token = process.env.DE_TOKEN ?? (server ? creds.servers[server]?.token : undefined);
  const project = process.env.DE_PROJECT ?? link?.project;
  return { root, server, token, project, linked: !!link };
}
