import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/hub.js';
import type { CfConfig } from '../src/types.js';

/**
 * These tests drive the real orchestration against a stub `cf` on PATH, so the
 * login -> active -> verify -> logout sequence is exercised end to end without
 * a Cloud Foundry landscape.
 */

const STUB = `#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const home = process.env.CF_HOME;
const configFile = join(home, '.cf', 'config.json');

const read = () => {
  try { return JSON.parse(readFileSync(configFile, 'utf8')); } catch { return {}; }
};
const write = (config) => {
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify(config, null, 2));
};
const jwt = (seconds) => {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return 'bearer ' + enc({ alg: 'none' }) + '.' + enc({ exp: Math.floor(Date.now() / 1000) + seconds }) + '.sig';
};

const command = args[0];
if (command === 'version') {
  process.stdout.write('cf version 8.7.10\\n');
} else if (command === 'login') {
  const passcode = args[args.indexOf('--sso-passcode') + 1];
  const api = args[args.indexOf('-a') + 1];
  if (passcode !== 'GOODCODE') {
    process.stderr.write('FAILED\\nCredentials were rejected, please try again.\\n');
    process.exit(1);
  }
  write({
    ...read(),
    Target: api,
    AuthorizationEndpoint: 'https://login.example.com',
    AccessToken: jwt(3600),
    RefreshToken: 'stub-refresh-token',
    OrganizationFields: { Name: '' },
    SpaceFields: { Name: '' },
  });
  process.stdout.write('OK\\n');
} else if (command === 'target') {
  const config = read();
  if (!config.AccessToken) { process.stderr.write('Not logged in.\\n'); process.exit(1); }
  const org = args.includes('-o') ? args[args.indexOf('-o') + 1] : config.OrganizationFields?.Name;
  const space = args.includes('-s') ? args[args.indexOf('-s') + 1] : config.SpaceFields?.Name;
  if (org === 'missing-org') { process.stderr.write('FAILED\\nOrganization missing-org not found\\n'); process.exit(1); }
  write({ ...config, OrganizationFields: { Name: org }, SpaceFields: { Name: space } });
  process.stdout.write('OK\\n');
} else if (command === 'curl') {
  const config = read();
  if (!config.AccessToken) {
    process.stdout.write(JSON.stringify({ errors: [{ detail: 'Invalid Auth Token', title: 'CF-InvalidAuthToken' }] }));
    process.exit(0);
  }
  // A real cf CLI refreshes the access token on every command; so does the stub.
  write({ ...config, AccessToken: jwt(3600) });
  process.stdout.write(JSON.stringify({ pagination: { total_results: 1 }, resources: [{ name: 'acme' }] }));
} else if (command === 'logout') {
  const config = read();
  delete config.AccessToken;
  delete config.RefreshToken;
  write({ ...config, OrganizationFields: { Name: '' }, SpaceFields: { Name: '' } });
  process.stdout.write('OK\\n');
} else {
  process.stderr.write('unknown command ' + command + '\\n');
  process.exit(1);
}
`;

let originalPath: string | undefined;

before(async () => {
  const binDir = await mkdtemp(join(tmpdir(), 'cf-stub-'));
  const stubPath = join(binDir, 'cf');
  await writeFile(stubPath, STUB);
  await chmod(stubPath, 0o755);
  // The stub is ESM; give it a package marker so node runs it as such.
  await writeFile(join(binDir, 'package.json'), JSON.stringify({ type: 'module' }));
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
});

after(() => {
  process.env.PATH = originalPath;
});

async function makeHub(): Promise<Hub> {
  const root = await mkdtemp(join(tmpdir(), 'cf-session-hub-flow-'));
  const hub = new Hub({ root, port: 0, keepAliveIntervalMs: 600_000, rescanIntervalMs: 600_000 });
  await hub.init();
  return hub;
}

async function readConfig(path: string): Promise<CfConfig> {
  return JSON.parse(await readFile(join(path, '.cf', 'config.json'), 'utf8')) as CfConfig;
}

test('a fresh entry starts unknown and becomes active after a passcode login', async () => {
  const hub = await makeHub();
  const created = await hub.createEntry({
    name: 'acme',
    api: 'https://api.cf.example.com',
    org: 'acme-org',
    space: 'prod',
  });
  assert.equal(created.status, 'unknown');
  assert.equal(created.api, 'https://api.cf.example.com');

  const loggedIn = await hub.completeLogin('acme', 'GOODCODE');
  assert.equal(loggedIn.status, 'active');
  assert.equal(loggedIn.org, 'acme-org');
  assert.equal(loggedIn.space, 'prod');
  assert.equal(loggedIn.loginState, 'idle');
  assert.equal(loggedIn.hasRefreshToken, true);
  assert.ok(!JSON.stringify(loggedIn).includes('stub-refresh-token'));

  // The token itself lives only in the cf CLI's own config.
  const config = await readConfig(loggedIn.path);
  assert.ok(config.AccessToken?.startsWith('bearer '));
});

test('a rejected passcode keeps the entry in waiting_passcode with a usable message', async () => {
  const hub = await makeHub();
  await hub.createEntry({ name: 'acme', api: 'https://api.cf.example.com' });

  await assert.rejects(() => hub.completeLogin('acme', 'WRONGCODE'), /Credentials were rejected/);

  const entry = await hub.requireEntry('acme');
  assert.equal(entry.loginState, 'waiting_passcode');
  assert.match(entry.lastError ?? '', /Credentials were rejected/);
  assert.ok(!(entry.lastError ?? '').includes('WRONGCODE'));
});

test('the passcode never reaches an error message', async () => {
  const hub = await makeHub();
  await hub.createEntry({ name: 'acme', api: 'https://api.cf.example.com' });
  await assert.rejects(() => hub.completeLogin('acme', 'SUPERSECRETPASSCODE'), (error: Error) => {
    assert.ok(!error.message.includes('SUPERSECRETPASSCODE'));
    return true;
  });
});

test('a failed target leaves the entry logged in and reports the problem', async () => {
  const hub = await makeHub();
  await hub.createEntry({ name: 'acme', api: 'https://api.cf.example.com', org: 'missing-org' });
  const entry = await hub.completeLogin('acme', 'GOODCODE');
  assert.equal(entry.status, 'active');
  assert.match(entry.lastError ?? '', /Organization missing-org not found/);
});

test('verify refreshes the token and reports an unusable session as an error', async () => {
  const hub = await makeHub();
  await hub.createEntry({ name: 'acme', api: 'https://api.cf.example.com' });
  await hub.completeLogin('acme', 'GOODCODE');

  const ok = await hub.verify('acme');
  assert.equal(ok.ok, true);
  assert.equal(ok.entry.status, 'active');
  assert.ok(ok.entry.lastVerifiedAt);

  await hub.logout('acme');
  const after = await hub.verify('acme');
  assert.equal(after.ok, false);
  assert.match(after.error ?? '', /Invalid Auth Token/);
});

test('logout clears the session and the entry reports it', async () => {
  const hub = await makeHub();
  await hub.createEntry({ name: 'acme', api: 'https://api.cf.example.com', org: 'acme-org' });
  await hub.completeLogin('acme', 'GOODCODE');

  const entry = await hub.logout('acme');
  assert.notEqual(entry.status, 'active');
  assert.equal(entry.hasRefreshToken, false);
  assert.equal(entry.lastVerifiedAt, null);
});

test('keep-alive verifies only the entries that opted in, and broadcasts', async () => {
  const hub = await makeHub();
  await hub.createEntry({ name: 'watched', api: 'https://api.cf.example.com', keepAlive: true });
  await hub.createEntry({ name: 'ignored', api: 'https://api.cf.example.com', keepAlive: false });
  await hub.completeLogin('watched', 'GOODCODE');
  await hub.completeLogin('ignored', 'GOODCODE');

  // Age the watched entry's token so the keep-alive pass has something to do.
  const watched = await hub.requireEntry('watched');
  const config = await readConfig(watched.path);
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const stale = `bearer ${encode({ alg: 'none' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 30 })}.sig`;
  await mkdir(join(watched.path, '.cf'), { recursive: true });
  await writeFile(join(watched.path, '.cf', 'config.json'), JSON.stringify({ ...config, AccessToken: stale }));
  assert.equal((await hub.requireEntry('watched')).status, 'refreshable');

  const ignoredBefore = (await hub.requireEntry('ignored')).lastVerifiedAt;
  const seen: string[] = [];
  hub.events.subscribe((event) => {
    if (event.type === 'entry') seen.push(event.entry.id);
  });
  await hub.runKeepAlive();

  assert.deepEqual(seen, ['watched']);
  assert.equal((await hub.requireEntry('watched')).status, 'active');
  // The opted-out entry was left untouched by the pass.
  assert.equal((await hub.requireEntry('ignored')).lastVerifiedAt, ignoredBefore);
});
