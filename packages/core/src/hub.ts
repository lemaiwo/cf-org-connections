import { mkdir } from 'node:fs/promises';
import type { HubConfig } from './config.js';
import { cfErrorMessage, runCf } from './cf.js';
import { openInBrowser } from './browser.js';
import { EventBus } from './events.js';
import {
  emptyRuntime,
  entryPath,
  isValidEntryId,
  loadEntries,
  loadEntry,
  readCfConfig,
  readHubMeta,
  writeHubMeta,
  type EntryRuntime,
} from './entries.js';
import { buildHandoff } from './handoff.js';
import { isValidPasscode, LoginEndpointError, passcodeUrl, resolveLoginEndpoint } from './login.js';
import type { Entry, Handoff, HubMeta, VerifyResult } from './types.js';

/** A request the hub rejects with a 4xx and a message the UI can show. */
export class HubError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface LoginStartResult {
  entry: Entry;
  passcodeUrl: string;
  browserOpened: boolean;
  /** Set when the browser could not be opened; the UI shows the URL instead. */
  browserError: string | null;
}

export interface CreateEntryInput {
  name: string;
  api: string;
  label?: string;
  org?: string;
  space?: string;
  keepAlive?: boolean;
}

/**
 * All hub logic lives here so that the dashboard and the CLI, both thin clients
 * over the REST API, behave identically.
 */
export class Hub {
  readonly config: HubConfig;
  readonly events = new EventBus();
  readonly #runtime = new Map<string, EntryRuntime>();
  #keepAliveTimer: NodeJS.Timeout | null = null;
  #rescanTimer: NodeJS.Timeout | null = null;
  #lastSnapshot = new Map<string, string>();

  constructor(config: HubConfig) {
    this.config = config;
  }

  /** Creates the root folder if it does not exist yet. */
  async init(): Promise<void> {
    await mkdir(this.config.root, { recursive: true });
  }

  #runtimeFor(id: string): EntryRuntime {
    let runtime = this.#runtime.get(id);
    if (!runtime) {
      runtime = emptyRuntime();
      this.#runtime.set(id, runtime);
    }
    return runtime;
  }

  async listEntries(): Promise<Entry[]> {
    return loadEntries(this.config.root, (id) => this.#runtimeFor(id));
  }

  /** Loads one entry or throws a 404-shaped error. */
  async requireEntry(id: string): Promise<Entry> {
    if (!isValidEntryId(id)) throw new HubError(`Invalid entry name: ${id}`, 400);
    const entry = await loadEntry(this.config.root, id, this.#runtimeFor(id));
    if (!entry) throw new HubError(`No such entry: ${id}`, 404);
    return entry;
  }

  /** Re-reads an entry and broadcasts it to every connected client. */
  async #publishEntry(id: string): Promise<Entry> {
    const entry = await this.requireEntry(id);
    this.#lastSnapshot.set(id, snapshotKey(entry));
    this.events.publish({ type: 'entry', entry });
    return entry;
  }

  async createEntry(input: CreateEntryInput): Promise<Entry> {
    const name = (input.name ?? '').trim();
    if (!isValidEntryId(name)) {
      throw new HubError(
        'Name must start with a letter or digit and contain only letters, digits, dot, dash or underscore.',
      );
    }
    const api = (input.api ?? '').trim();
    if (!/^https?:\/\/[^\s]+$/.test(api)) {
      throw new HubError('API endpoint must be an http(s) URL, for example https://api.cf.example.com.');
    }
    const dir = entryPath(this.config.root, name);
    const existing = await loadEntry(this.config.root, name, this.#runtimeFor(name));
    if (existing) throw new HubError(`An entry named ${name} already exists.`, 409);

    await mkdir(dir, { recursive: true });
    const meta: HubMeta = {
      label: input.label?.trim() || name,
      api,
      keepAlive: input.keepAlive ?? true,
    };
    if (input.org?.trim()) meta.defaultOrg = input.org.trim();
    if (input.space?.trim()) meta.defaultSpace = input.space.trim();
    await writeHubMeta(dir, meta);
    return this.#publishEntry(name);
  }

  /** Updates hub metadata (label, defaults, keep-alive) for an entry. */
  async updateEntry(id: string, patch: HubMeta): Promise<Entry> {
    const entry = await this.requireEntry(id);
    const clean: HubMeta = {};
    if (patch.label !== undefined) clean.label = String(patch.label).trim() || entry.id;
    if (patch.defaultOrg !== undefined) clean.defaultOrg = String(patch.defaultOrg).trim();
    if (patch.defaultSpace !== undefined) clean.defaultSpace = String(patch.defaultSpace).trim();
    if (patch.keepAlive !== undefined) clean.keepAlive = patch.keepAlive === true;
    if (patch.api !== undefined) {
      const api = String(patch.api).trim();
      if (api && !/^https?:\/\/[^\s]+$/.test(api)) {
        throw new HubError('API endpoint must be an http(s) URL.');
      }
      clean.api = api;
    }
    await writeHubMeta(entry.path, clean);
    return this.#publishEntry(id);
  }

  /**
   * Step 1 of the SSO flow: resolve the passcode URL and open it in the user's
   * browser. The entry stays in `waiting_passcode` until the paste arrives.
   */
  async startLogin(id: string): Promise<LoginStartResult> {
    const entry = await this.requireEntry(id);
    const [config, meta] = await Promise.all([readCfConfig(entry.path), readHubMeta(entry.path)]);
    const api = config?.Target || meta.api || null;

    let url: string;
    try {
      url = passcodeUrl(await resolveLoginEndpoint(config, api));
    } catch (error) {
      const message =
        error instanceof LoginEndpointError ? error.message : (error as Error).message;
      const runtime = this.#runtimeFor(id);
      runtime.loginState = 'idle';
      runtime.lastError = message;
      await this.#publishEntry(id);
      throw new HubError(message, 502);
    }

    const browserError = await openInBrowser(url);
    const runtime = this.#runtimeFor(id);
    runtime.loginState = 'waiting_passcode';
    runtime.lastError = browserError;
    const updated = await this.#publishEntry(id);

    return {
      entry: updated,
      passcodeUrl: url,
      browserOpened: browserError === null,
      browserError,
    };
  }

  /**
   * Step 2 of the SSO flow: hand the one-time passcode to the cf CLI, then
   * target the stored default org and space. The passcode is used once and is
   * never logged or stored.
   */
  async completeLogin(id: string, passcode: unknown): Promise<Entry> {
    const entry = await this.requireEntry(id);
    if (!isValidPasscode(passcode)) {
      throw new HubError('Enter the one-time passcode from the browser page.');
    }
    const code = passcode.trim();
    const meta = await readHubMeta(entry.path);
    const api = entry.api || meta.api;
    if (!api) {
      throw new HubError('No API endpoint known for this entry. Set one in hub.json first.');
    }

    const runtime = this.#runtimeFor(id);
    runtime.loginState = 'logging_in';
    runtime.lastError = null;
    await this.#publishEntry(id);

    const login = await runCf(['login', '-a', api, '--sso-passcode', code], {
      cfHome: entry.path,
      timeoutMs: 90_000,
      redact: [code],
    });

    if (login.code !== 0) {
      // Keep the entry in waiting_passcode so the UI can offer a new passcode.
      runtime.loginState = 'waiting_passcode';
      runtime.lastError = cfErrorMessage(login, 'Login failed. The passcode may be invalid or expired.');
      await this.#publishEntry(id);
      throw new HubError(runtime.lastError, 401);
    }

    const org = meta.defaultOrg?.trim();
    const space = meta.defaultSpace?.trim();
    if (org) {
      const targetArgs = space ? ['target', '-o', org, '-s', space] : ['target', '-o', org];
      const target = await runCf(targetArgs, { cfHome: entry.path, timeoutMs: 60_000 });
      if (target.code !== 0) {
        runtime.loginState = 'idle';
        runtime.lastError = cfErrorMessage(target, `Logged in, but could not target ${org}.`);
        await this.#publishEntry(id);
        return this.requireEntry(id);
      }
    }

    runtime.loginState = 'idle';
    runtime.lastError = null;
    runtime.lastVerifiedAt = new Date().toISOString();
    return this.#publishEntry(id);
  }

  /**
   * Live check. Running any cf command makes the CLI refresh the access token
   * with its refresh token, so this doubles as the keep-alive tick.
   */
  async verify(id: string): Promise<VerifyResult> {
    const entry = await this.requireEntry(id);
    const runtime = this.#runtimeFor(id);
    const result = await runCf(['curl', '/v3/organizations?per_page=1'], {
      cfHome: entry.path,
      timeoutMs: 45_000,
    });

    const ok = result.code === 0 && !looksLikeCfError(result.stdout);
    if (ok) {
      runtime.lastVerifiedAt = new Date().toISOString();
      runtime.lastError = null;
    } else {
      runtime.lastError = looksLikeCfError(result.stdout)
        ? cfApiErrorMessage(result.stdout)
        : cfErrorMessage(result, 'The session is no longer usable. Log in again.');
    }
    const updated = await this.#publishEntry(id);
    return ok ? { ok, entry: updated } : { ok, entry: updated, error: runtime.lastError ?? undefined };
  }

  async logout(id: string): Promise<Entry> {
    const entry = await this.requireEntry(id);
    const runtime = this.#runtimeFor(id);
    const result = await runCf(['logout'], { cfHome: entry.path, timeoutMs: 30_000 });
    runtime.loginState = 'idle';
    runtime.lastVerifiedAt = null;
    runtime.lastError = result.code === 0 ? null : cfErrorMessage(result, 'Logout failed.');
    const updated = await this.#publishEntry(id);
    if (result.code !== 0) throw new HubError(runtime.lastError ?? 'Logout failed.', 500);
    return updated;
  }

  async handoff(id: string): Promise<Handoff> {
    return buildHandoff(await this.requireEntry(id));
  }

  /** Snapshot for a client that has just connected to the event stream. */
  async snapshot(): Promise<Entry[]> {
    const entries = await this.listEntries();
    this.#lastSnapshot = new Map(entries.map((e) => [e.id, snapshotKey(e)]));
    return entries;
  }

  /** Starts the keep-alive scheduler and the background re-scan. */
  startSchedulers(): void {
    this.stopSchedulers();
    this.#keepAliveTimer = setInterval(() => {
      void this.runKeepAlive();
    }, this.config.keepAliveIntervalMs);
    this.#keepAliveTimer.unref();

    this.#rescanTimer = setInterval(() => {
      void this.rescan();
    }, this.config.rescanIntervalMs);
    this.#rescanTimer.unref();
  }

  stopSchedulers(): void {
    if (this.#keepAliveTimer) clearInterval(this.#keepAliveTimer);
    if (this.#rescanTimer) clearInterval(this.#rescanTimer);
    this.#keepAliveTimer = null;
    this.#rescanTimer = null;
  }

  /**
   * One keep-alive pass: a live check for every entry with `keepAlive: true`.
   * The cf CLI refreshes its own token; the hub only makes sure a command runs
   * often enough, and never tries to outlive the refresh token.
   */
  async runKeepAlive(): Promise<void> {
    const entries = await this.listEntries();
    for (const entry of entries) {
      if (!entry.keepAlive) continue;
      if (entry.status === 'unknown') continue;
      if (this.#runtimeFor(entry.id).loginState !== 'idle') continue;
      try {
        await this.verify(entry.id);
      } catch {
        // verify() already recorded the error on the entry.
      }
    }
  }

  /**
   * Picks up changes made outside the hub (a cf command run by hand, a new
   * directory) and broadcasts only what actually changed.
   */
  async rescan(): Promise<void> {
    const entries = await this.listEntries();
    const seen = new Set<string>();
    for (const entry of entries) {
      seen.add(entry.id);
      const key = snapshotKey(entry);
      if (this.#lastSnapshot.get(entry.id) !== key) {
        this.#lastSnapshot.set(entry.id, key);
        this.events.publish({ type: 'entry', entry });
      }
    }
    for (const id of [...this.#lastSnapshot.keys()]) {
      if (!seen.has(id)) {
        this.#lastSnapshot.delete(id);
        this.#runtime.delete(id);
        this.events.publish({ type: 'removed', id });
      }
    }
  }
}

/**
 * Change key for an entry. Countdowns are rendered client-side from
 * `expiresAt`, so the ticking seconds field must not count as a change.
 */
function snapshotKey(entry: Entry): string {
  return JSON.stringify({ ...entry, expiresInSeconds: 0 });
}

/** `cf curl` exits 0 even when the API answers with an error document. */
function looksLikeCfError(stdout: string): boolean {
  const parsed = parseJson(stdout);
  return Boolean(parsed && typeof parsed === 'object' && 'errors' in parsed);
}

function cfApiErrorMessage(stdout: string): string {
  const parsed = parseJson(stdout) as { errors?: Array<{ detail?: string; title?: string }> } | null;
  const first = parsed?.errors?.[0];
  return first?.detail || first?.title || 'The CF API rejected the request.';
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
