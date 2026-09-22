import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
  const path = args[1] || '';
  if (path.indexOf('/v3/organizations') === 0) {
    process.stdout.write(JSON.stringify({ pagination: { next: null }, resources: [
      { guid: 'org-1', name: 'acme-org' },
      { guid: 'org-2', name: 'beta-org' },
    ] }));
  } else if (path.indexOf('/v3/spaces') === 0) {
    const match = /organization_guids=([^&]*)/.exec(path);
    const org = match ? decodeURIComponent(match[1]) : '';
    const spaces = org === 'org-1'
      ? [{ guid: 'space-1', name: 'dev' }, { guid: 'space-2', name: 'prod' }]
      : [{ guid: 'space-3', name: 'beta-only' }];
    process.stdout.write(JSON.stringify({ pagination: { next: null }, resources: spaces }));
  } else {
    process.stdout.write(JSON.stringify({ pagination: { total_results: 1 }, resources: [{ name: 'acme' }] }));
  }
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
  await writeFile(join(binDir, 'cf-stub.mjs'), STUB);
  const stubPath = join(binDir, 'cf');
  await writeFile(stubPath, `#!/bin/sh\nexec node "$(dirname "$0")/cf-stub.mjs" "$@"\n`);
  await chmod(stubPath, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ''}`;
});

after(() => {
  process.env.PATH = originalPath;
});

/**
 * The stub is a POSIX shell script. Node refuses to spawn a .cmd shim without
 * a shell, and giving runCf a shell would put passcodes through shell quoting,
 * so on Windows these tests are skipped rather than run against the real cf.
 */
const posixOnly = {
  skip: process.platform === "win32" ? "needs a POSIX cf stub on PATH" : false,
};

async function makeHub(): Promise<Hub> {
  const root = await mkdtemp(join(tmpdir(), 'cf-session-hub-flow-'));
  const hub = new Hub({ root, paths: [], port: 0, keepAliveIntervalMs: 600_000, rescanIntervalMs: 600_000 });
  await hub.init();
  return hub;
}

async function readConfig(path: string): Promise<CfConfig> {
  return JSON.parse(await readFile(join(path, '.cf', 'config.json'), 'utf8')) as CfConfig;
}

test('a fresh entry starts unknown and becomes active after a passcode login', posixOnly, async () => {
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

test('a rejected passcode keeps the entry in waiting_passcode with a usable message', posixOnly, async () => {
  const hub = await makeHub();
  await hub.createEntry({ name: 'acme', api: 'https://api.cf.example.com' });

  await assert.rejects(() => hub.completeLogin('acme', 'WRONGCODE'), /Credentials were rejected/);

  const entry = await hub.requireEntry('acme');
  assert.equal(entry.loginState, 'waiting_passcode');
  assert.match(entry.lastError ?? '', /Credentials were rejected/);
  assert.ok(!(entry.lastError ?? '').includes('WRONGCODE'));
});

test('the passcode never reaches an error message', posixOnly, async () => {
  const hub = await makeHub();
  await hub.createEntry({ name: 'acme', api: 'https://api.cf.example.com' });
  await assert.rejects(() => hub.completeLogin('acme', 'SUPERSECRETPASSCODE'), (error: Error) => {
    assert.ok(!error.message.includes('SUPERSECRETPASSCODE'));
    return true;
  });
});

test('a failed target leaves the entry logged in and reports the problem', posixOnly, async () => {
  const hub = await makeHub();
  await hub.createEntry({ name: 'acme', api: 'https://api.cf.example.com', org: 'missing-org' });
  const entry = await hub.completeLogin('acme', 'GOODCODE');
  assert.equal(entry.status, 'active');
  assert.match(entry.lastError ?? '', /Organization missing-org not found/);
});

test('verify refreshes the token and reports an unusable session as an error', posixOnly, async () => {
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

test('logout clears the session and the entry reports it', posixOnly, async () => {
  const hub = await makeHub();
  await hub.createEntry({ name: 'acme', api: 'https://api.cf.example.com', org: 'acme-org' });
  await hub.completeLogin('acme', 'GOODCODE');

  const entry = await hub.logout('acme');
  assert.notEqual(entry.status, 'active');
  assert.equal(entry.hasRefreshToken, false);
  assert.equal(entry.lastVerifiedAt, null);
});

test('keep-alive verifies only the entries that opted in, and broadcasts', posixOnly, async () => {
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

test('the org list comes back from the CF API', posixOnly, async () => {
  const hub = await makeHub();
  await hub.createEntry({ name: 'acme', api: 'https://api.cf.example.com' });
  await hub.completeLogin('acme', 'GOODCODE');

  assert.deepEqual(await hub.listOrgs('acme'), [
    { guid: 'org-1', name: 'acme-org' },
    { guid: 'org-2', name: 'beta-org' },
  ]);
});

test('spaces are listed for one organization only', posixOnly, async () => {
  const hub = await makeHub();
  await hub.createEntry({ name: 'acme', api: 'https://api.cf.example.com' });
  await hub.completeLogin('acme', 'GOODCODE');

  assert.deepEqual(await hub.listSpaces('acme', 'org-1'), [
    { guid: 'space-1', name: 'dev' },
    { guid: 'space-2', name: 'prod' },
  ]);
  assert.deepEqual(await hub.listSpaces('acme', 'org-2'), [{ guid: 'space-3', name: 'beta-only' }]);
});

test('listing orgs on a logged-out entry says to log in, rather than reading empty', posixOnly, async () => {
  const hub = await makeHub();
  await hub.createEntry({ name: 'acme', api: 'https://api.cf.example.com' });
  await hub.completeLogin('acme', 'GOODCODE');
  await hub.logout('acme');

  await assert.rejects(() => hub.listOrgs('acme'), /Invalid Auth Token/);
});

test('switching target moves the entry to the new org and space', posixOnly, async () => {
  const hub = await makeHub();
  await hub.createEntry({ name: 'acme', api: 'https://api.cf.example.com', org: 'acme-org', space: 'dev' });
  await hub.completeLogin('acme', 'GOODCODE');

  const switched = await hub.setTarget('acme', { org: 'beta-org', space: 'beta-only' });
  assert.equal(switched.org, 'beta-org');
  assert.equal(switched.space, 'beta-only');
});

test('switching target stores the choice as the entry default', posixOnly, async () => {
  const hub = await makeHub();
  await hub.createEntry({ name: 'acme', api: 'https://api.cf.example.com', org: 'acme-org', space: 'dev' });
  await hub.completeLogin('acme', 'GOODCODE');

  const switched = await hub.setTarget('acme', { org: 'beta-org', space: 'beta-only' });
  assert.equal(switched.defaultOrg, 'beta-org');
  assert.equal(switched.defaultSpace, 'beta-only');

  const meta = JSON.parse(await readFile(join(switched.path, 'hub.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(meta.defaultOrg, 'beta-org');
  assert.equal(meta.defaultSpace, 'beta-only');
});

test('a switched target survives the next login', posixOnly, async () => {
  const hub = await makeHub();
  await hub.createEntry({ name: 'acme', api: 'https://api.cf.example.com', org: 'acme-org', space: 'dev' });
  await hub.completeLogin('acme', 'GOODCODE');
  await hub.setTarget('acme', { org: 'beta-org', space: 'beta-only' });

  // completeLogin re-targets from the stored defaults, so the switch must stick.
  const again = await hub.completeLogin('acme', 'GOODCODE');
  assert.equal(again.org, 'beta-org');
  assert.equal(again.space, 'beta-only');
});

test('switching to an org alone clears the space', posixOnly, async () => {
  const hub = await makeHub();
  await hub.createEntry({ name: 'acme', api: 'https://api.cf.example.com', org: 'acme-org', space: 'dev' });
  await hub.completeLogin('acme', 'GOODCODE');

  const switched = await hub.setTarget('acme', { org: 'beta-org', space: null });
  assert.equal(switched.org, 'beta-org');
  assert.equal(switched.defaultSpace, null);
});

test('switching to an org the CF API rejects reports the cf error', posixOnly, async () => {
  const hub = await makeHub();
  await hub.createEntry({ name: 'acme', api: 'https://api.cf.example.com' });
  await hub.completeLogin('acme', 'GOODCODE');

  await assert.rejects(() => hub.setTarget('acme', { org: 'missing-org', space: null }), /missing-org not found/);
});

test('switching target refuses an empty org', posixOnly, async () => {
  const hub = await makeHub();
  await hub.createEntry({ name: 'acme', api: 'https://api.cf.example.com' });
  await hub.completeLogin('acme', 'GOODCODE');

  await assert.rejects(() => hub.setTarget('acme', { org: '   ', space: 'dev' }), /organization/i);
});
