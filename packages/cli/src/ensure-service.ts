import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadConfig } from '@cf-session-hub/core';
import { HubClient } from './client.js';

const STARTUP_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 200;

/**
 * Returns a client for the running core service, starting it in the background
 * first if it is not up yet. `cfhub` is meant to be usable straight from a
 * terminal without starting anything by hand.
 */
export async function ensureService(): Promise<HubClient> {
  const config = await loadConfig();
  const baseUrl = process.env.CF_SESSION_HUB_URL ?? `http://127.0.0.1:${config.port}`;
  const client = new HubClient(baseUrl);

  if (await isUp(client)) return client;
  if (process.env.CF_SESSION_HUB_URL) {
    throw new Error(`No CF Session Hub at ${baseUrl}. Start it there, or unset CF_SESSION_HUB_URL.`);
  }

  spawnService();

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS);
    if (await isUp(client)) return client;
  }
  throw new Error(
    `Could not start the CF Session Hub service on ${baseUrl}. Run cf-session-hub manually to see why.`,
  );
}

async function isUp(client: HubClient): Promise<boolean> {
  try {
    const health = await client.health();
    return health.ok === true;
  } catch {
    return false;
  }
}

/** Starts the core service detached, so it outlives this CLI invocation. */
function spawnService(): void {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@cf-session-hub/core/bin');
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
