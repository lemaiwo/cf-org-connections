import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { emptyRuntime, entryPath, loadEntries, loadEntry, resolveEntryDir } from '../src/entries.js';
import { loadConfig } from '../src/config.js';

function jwt(expSeconds: number): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `bearer ${encode({ alg: 'none' })}.${encode({ exp: expSeconds })}.signature`;
}

/** Creates a CF home directory holding the cf CLI's own config. */
async function makeCfHome(dir: string, org: string, space: string): Promise<string> {
  await mkdir(join(dir, '.cf'), { recursive: true });
  await writeFile(
    join(dir, '.cf', 'config.json'),
    JSON.stringify({
      Target: 'https://api.cf.example.com',
      AccessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
      RefreshToken: 'refresh-token-value',
      OrganizationFields: { Name: org },
      SpaceFields: { Name: space },
    }),
  );
  return dir;
}

test('entryPath accepts a plain name on this platform', () => {
  const root = resolve(tmpdir(), 'cf-homes');
  assert.equal(entryPath(root, 'acme-prod'), join(root, 'acme-prod'));
});

test('entryPath still refuses anything that escapes the root', () => {
  const root = resolve(tmpdir(), 'cf-homes');
  assert.throws(() => entryPath(root, '..'), /Invalid entry name/);
  assert.throws(() => entryPath(root, '../etc'), /Invalid entry name/);
  assert.throws(() => entryPath(root, `..${sep}etc`), /Invalid entry name/);
  assert.throws(() => entryPath(root, 'a/b'), /Invalid entry name/);
});

test('a registered path resolves to its own directory, outside the root', () => {
  const root = resolve(tmpdir(), 'cf-homes');
  const outside = resolve(homedir(), '.cf-elia');
  assert.equal(resolveEntryDir(root, [{ id: 'elia', dir: outside }], 'elia'), outside);
});

test('an id with no registered path still resolves under the root', () => {
  const root = resolve(tmpdir(), 'cf-homes');
  assert.equal(resolveEntryDir(root, [{ id: 'elia', dir: '/somewhere' }], 'acme'), join(root, 'acme'));
});

test('entries adopted from outside the root are listed with their org and space', async () => {
  const base = await mkdtemp(join(tmpdir(), 'cf-hub-adopt-'));
  const root = join(base, '.cf-homes');
  await mkdir(root, { recursive: true });
  await makeCfHome(join(base, '.cf-elia'), 'elia-org', 'dev');
  await makeCfHome(join(base, '.ec'), '210-sandbox', 'BC');

  const entries = await loadEntries(
    root,
    [
      { id: 'elia', dir: join(base, '.cf-elia') },
      { id: 'ec', dir: join(base, '.ec') },
    ],
    () => emptyRuntime(),
  );

  assert.deepEqual(
    entries.map((e) => [e.id, e.org, e.space, e.status]),
    [
      ['ec', '210-sandbox', 'BC', 'active'],
      ['elia', 'elia-org', 'dev', 'active'],
    ],
  );
  assert.equal(entries[1]?.path, join(base, '.cf-elia'));
});

test('adopted entries and root subdirectories appear in one list', async () => {
  const base = await mkdtemp(join(tmpdir(), 'cf-hub-adopt-'));
  const root = join(base, '.cf-homes');
  await makeCfHome(join(root, 'acme-prod'), 'acme', 'prod');
  await makeCfHome(join(base, '.cf-elia'), 'elia-org', 'dev');

  const entries = await loadEntries(root, [{ id: 'elia', dir: join(base, '.cf-elia') }], () =>
    emptyRuntime(),
  );
  assert.deepEqual(
    entries.map((e) => e.id),
    ['acme-prod', 'elia'],
  );
});

test('a registered path wins over a root subdirectory with the same id', async () => {
  const base = await mkdtemp(join(tmpdir(), 'cf-hub-adopt-'));
  const root = join(base, '.cf-homes');
  await makeCfHome(join(root, 'elia'), 'from-root', 'root-space');
  await makeCfHome(join(base, '.cf-elia'), 'from-registered', 'registered-space');

  const registered = [{ id: 'elia', dir: join(base, '.cf-elia') }];
  const entries = await loadEntries(root, registered, () => emptyRuntime());

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.org, 'from-registered');
  assert.equal(entries[0]?.path, join(base, '.cf-elia'));
});

test('a registered path that does not exist is skipped, not an error', async () => {
  const base = await mkdtemp(join(tmpdir(), 'cf-hub-adopt-'));
  const root = join(base, '.cf-homes');
  await mkdir(root, { recursive: true });

  const registered = [{ id: 'gone', dir: join(base, 'no-such-dir') }];
  assert.deepEqual(await loadEntries(root, registered, () => emptyRuntime()), []);
  assert.equal(await loadEntry(root, registered, 'gone', emptyRuntime()), null);
});

test('loadEntry reads a single adopted entry by id', async () => {
  const base = await mkdtemp(join(tmpdir(), 'cf-hub-adopt-'));
  const root = join(base, '.cf-homes');
  await mkdir(root, { recursive: true });
  await makeCfHome(join(base, '.ec'), '210-sandbox', 'BC');

  const entry = await loadEntry(root, [{ id: 'ec', dir: join(base, '.ec') }], 'ec', emptyRuntime());
  assert.equal(entry?.path, join(base, '.ec'));
  assert.equal(entry?.org, '210-sandbox');
});

test('the config file supplies registered paths, with ~ expanded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cf-hub-config-'));
  const file = join(dir, 'config.json');
  await writeFile(
    file,
    JSON.stringify({
      root: '~/.cf-homes',
      paths: [
        { id: 'elia', dir: '~/.cf-elia' },
        { id: 'ec', dir: join(dir, '.ec') },
      ],
    }),
  );

  const previous = process.env.CF_SESSION_HUB_CONFIG;
  process.env.CF_SESSION_HUB_CONFIG = file;
  try {
    const config = await loadConfig();
    assert.deepEqual(config.paths, [
      { id: 'elia', dir: resolve(homedir(), '.cf-elia') },
      { id: 'ec', dir: join(dir, '.ec') },
    ]);
  } finally {
    if (previous === undefined) delete process.env.CF_SESSION_HUB_CONFIG;
    else process.env.CF_SESSION_HUB_CONFIG = previous;
  }
});

test('malformed registered paths are dropped rather than breaking the scan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cf-hub-config-'));
  const file = join(dir, 'config.json');
  await writeFile(
    file,
    JSON.stringify({
      paths: [
        { id: '../escape', dir: '/tmp/x' },
        { id: 'no-dir' },
        { dir: '/tmp/no-id' },
        'not-an-object',
        { id: 'good', dir: '/tmp/good' },
      ],
    }),
  );

  const previous = process.env.CF_SESSION_HUB_CONFIG;
  process.env.CF_SESSION_HUB_CONFIG = file;
  try {
    const config = await loadConfig();
    assert.deepEqual(
      config.paths.map((p) => p.id),
      ['good'],
    );
  } finally {
    if (previous === undefined) delete process.env.CF_SESSION_HUB_CONFIG;
    else process.env.CF_SESSION_HUB_CONFIG = previous;
  }
});

test('a config file without paths yields an empty list, not undefined', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cf-hub-config-'));
  const file = join(dir, 'config.json');
  await writeFile(file, JSON.stringify({ port: 4790 }));

  const previous = process.env.CF_SESSION_HUB_CONFIG;
  process.env.CF_SESSION_HUB_CONFIG = file;
  try {
    assert.deepEqual((await loadConfig()).paths, []);
  } finally {
    if (previous === undefined) delete process.env.CF_SESSION_HUB_CONFIG;
    else process.env.CF_SESSION_HUB_CONFIG = previous;
  }
});
