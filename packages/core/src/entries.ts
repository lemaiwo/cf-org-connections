import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tokenExpiryMs } from './jwt.js';
import type {
  CfConfig,
  Entry,
  EntryStatus,
  HubMeta,
  LoginState,
  RegisteredPath,
} from './types.js';

/** An access token this close to expiry no longer counts as `active`. */
export const ACTIVE_MARGIN_MS = 5 * 60 * 1000;

/** Entry ids double as directory names, so they are deliberately narrow. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Mutable, per-entry state the service keeps in memory (never persisted). */
export interface EntryRuntime {
  loginState: LoginState;
  lastVerifiedAt: string | null;
  lastError: string | null;
}

export function emptyRuntime(): EntryRuntime {
  return { loginState: 'idle', lastVerifiedAt: null, lastError: null };
}

/**
 * Validates an entry id. Rejects anything that could escape the root folder
 * (`.`, `..`, separators) before it is ever joined onto a path.
 */
export function isValidEntryId(id: string): boolean {
  if (!id || id.length > 100) return false;
  if (id === '.' || id === '..') return false;
  if (id.includes('/') || id.includes('\\')) return false;
  return ID_PATTERN.test(id);
}

/**
 * Absolute path of an entry's directory under the root folder. Containment is
 * checked with `relative()` rather than a string prefix, so it holds on
 * Windows, where paths are separated by `\` and not `/`.
 */
export function entryPath(root: string, id: string): string {
  if (!isValidEntryId(id)) {
    throw new Error(`Invalid entry name: ${id}`);
  }
  const rootResolved = resolve(root);
  const path = resolve(rootResolved, id);
  const rel = relative(rootResolved, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Invalid entry name: ${id}`);
  }
  return path;
}

/**
 * Directory an entry id points at. A registered path wins over a subdirectory
 * of the root with the same id, so an adopted directory always keeps its own
 * location.
 */
export function resolveEntryDir(
  root: string,
  registered: readonly RegisteredPath[],
  id: string,
): string {
  const match = registered.find((p) => p.id === id);
  if (match) return resolve(match.dir);
  return entryPath(root, id);
}

/** Reads the cf CLI's own config for a CF home directory. */
export async function readCfConfig(dir: string): Promise<CfConfig | null> {
  try {
    const raw = await readFile(join(dir, '.cf', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as CfConfig;
  } catch {
    return null;
  }
}

/** Reads the hub's optional per-entry metadata. */
export async function readHubMeta(dir: string): Promise<HubMeta> {
  try {
    const raw = await readFile(join(dir, 'hub.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as HubMeta;
  } catch {
    return {};
  }
}

/** Writes the hub's per-entry metadata, merging into what is already there. */
export async function writeHubMeta(dir: string, patch: HubMeta): Promise<HubMeta> {
  const current = await readHubMeta(dir);
  const next: HubMeta = { ...current, ...patch };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'hub.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/**
 * Derives an entry's status from its cf config.
 *
 * - `active`      access token expires more than 5 minutes from now
 * - `refreshable` token expired or expiring, but a refresh token is present
 * - `expired`     no usable token and no refresh token
 * - `unknown`     no readable cf config at all
 */
export function deriveStatus(config: CfConfig | null, now: number = Date.now()): EntryStatus {
  if (!config) return 'unknown';
  const expiry = tokenExpiryMs(config.AccessToken);
  if (expiry !== null && expiry - now > ACTIVE_MARGIN_MS) return 'active';
  const hasRefreshToken = typeof config.RefreshToken === 'string' && config.RefreshToken.length > 0;
  if (hasRefreshToken) return 'refreshable';
  if (expiry === null && !config.Target) return 'unknown';
  return 'expired';
}

/** Builds the token-free API representation of one entry. */
export function buildEntry(
  id: string,
  path: string,
  config: CfConfig | null,
  meta: HubMeta,
  runtime: EntryRuntime,
  now: number = Date.now(),
): Entry {
  const expiry = tokenExpiryMs(config?.AccessToken);
  return {
    id,
    label: meta.label?.trim() || id,
    path,
    api: config?.Target || meta.api || null,
    org: config?.OrganizationFields?.Name || null,
    space: config?.SpaceFields?.Name || null,
    defaultOrg: meta.defaultOrg || null,
    defaultSpace: meta.defaultSpace || null,
    status: deriveStatus(config, now),
    expiresAt: expiry === null ? null : new Date(expiry).toISOString(),
    expiresInSeconds: expiry === null ? null : Math.round((expiry - now) / 1000),
    hasRefreshToken: typeof config?.RefreshToken === 'string' && config.RefreshToken.length > 0,
    keepAlive: meta.keepAlive === true,
    loginState: runtime.loginState,
    lastVerifiedAt: runtime.lastVerifiedAt,
    lastError: runtime.lastError,
  };
}

/** Reads one entry from disk. Returns null when the directory does not exist. */
export async function loadEntry(
  root: string,
  registered: readonly RegisteredPath[],
  id: string,
  runtime: EntryRuntime,
): Promise<Entry | null> {
  const path = resolveEntryDir(root, registered, id);
  if (!(await isDirectory(path))) return null;
  const [config, meta] = await Promise.all([readCfConfig(path), readHubMeta(path)]);
  return buildEntry(id, path, config, meta, runtime);
}

/**
 * Lists every subdirectory of the root plus every registered path as an entry.
 * A missing root is treated as an empty list rather than an error, so a first
 * run works out of the box; a registered directory that has gone away is
 * skipped for the same reason.
 */
export async function loadEntries(
  root: string,
  registered: readonly RegisteredPath[],
  runtimeFor: (id: string) => EntryRuntime,
): Promise<Entry[]> {
  const dirs = new Map<string, string>();
  try {
    for (const dirent of await readdir(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      if (dirent.name.startsWith('.') || !isValidEntryId(dirent.name)) continue;
      dirs.set(dirent.name, join(root, dirent.name));
    }
  } catch {
    // No root folder yet: registered paths alone still make a list.
  }
  // Registered paths are set last, so they win over a same-named root subdirectory.
  for (const path of registered) {
    if (!isValidEntryId(path.id)) continue;
    dirs.set(path.id, resolve(path.dir));
  }

  const ids = [...dirs.keys()].sort((a, b) => a.localeCompare(b));
  const entries = await Promise.all(
    ids.map(async (id) => {
      const path = dirs.get(id) as string;
      if (!(await isDirectory(path))) return null;
      const [config, meta] = await Promise.all([readCfConfig(path), readHubMeta(path)]);
      return buildEntry(id, path, config, meta, runtimeFor(id));
    }),
  );
  return entries.filter((entry): entry is Entry => entry !== null);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
