import { homedir } from 'node:os';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

/** Runtime configuration of the hub itself, stored outside the CF home root. */
export interface HubConfig {
  /** Root folder holding one subdirectory per organization. */
  root: string;
  /** Port the core service binds on 127.0.0.1. */
  port: number;
  /** How often keep-alive entries get a live check, in milliseconds. */
  keepAliveIntervalMs: number;
  /** How often the service re-scans the root for external changes, in milliseconds. */
  rescanIntervalMs: number;
}

export const DEFAULT_PORT = 4790;
export const DEFAULT_ROOT = '~/.cf-homes';
export const DEFAULT_KEEP_ALIVE_INTERVAL_MS = 10 * 60 * 1000;
export const DEFAULT_RESCAN_INTERVAL_MS = 30 * 1000;

/** Expands a leading `~` and makes the path absolute. */
export function expandPath(input: string): string {
  const expanded = input.startsWith('~')
    ? input.replace(/^~(?=$|[/\\])/, homedir())
    : input;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

/** Path of the hub's own config file. */
export function configPath(): string {
  const override = process.env.CF_SESSION_HUB_CONFIG;
  if (override) return expandPath(override);
  return resolve(homedir(), '.config', 'cf-session-hub', 'config.json');
}

function positiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Loads the hub config, applying (in increasing precedence) defaults, the
 * config file and `CF_SESSION_HUB_*` environment variables. A missing or
 * unreadable config file is not an error: the defaults are used.
 */
export async function loadConfig(): Promise<HubConfig> {
  let fromFile: Partial<HubConfig> = {};
  try {
    const raw = await readFile(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') fromFile = parsed as Partial<HubConfig>;
  } catch {
    // No config file yet, or it is unreadable: fall back to the defaults.
  }

  const root = process.env.CF_SESSION_HUB_ROOT ?? fromFile.root ?? DEFAULT_ROOT;
  return {
    root: expandPath(root),
    port: positiveInt(process.env.CF_SESSION_HUB_PORT ?? fromFile.port, DEFAULT_PORT),
    keepAliveIntervalMs: positiveInt(
      process.env.CF_SESSION_HUB_KEEPALIVE_MS ?? fromFile.keepAliveIntervalMs,
      DEFAULT_KEEP_ALIVE_INTERVAL_MS,
    ),
    rescanIntervalMs: positiveInt(
      process.env.CF_SESSION_HUB_RESCAN_MS ?? fromFile.rescanIntervalMs,
      DEFAULT_RESCAN_INTERVAL_MS,
    ),
  };
}

/** Writes the hub config file, creating `~/.config/cf-session-hub` if needed. */
export async function saveConfig(config: HubConfig): Promise<void> {
  const target = configPath();
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
