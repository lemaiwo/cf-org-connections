import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService, type StartedService } from '../src/service.js';

function jwt(expSeconds: number): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `bearer ${encode({ alg: 'none' })}.${encode({ exp: expSeconds })}.signature`;
}

/** Builds a CF home root with one already-authenticated organization in it. */
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cf-session-hub-'));
  const acme = join(root, 'acme-prod');
  await mkdir(join(acme, '.cf'), { recursive: true });
  await writeFile(
    join(acme, '.cf', 'config.json'),
    JSON.stringify({
      Target: 'https://api.cf.example.com',
      AuthorizationEndpoint: 'https://login.cf.example.com',
      AccessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
      RefreshToken: 'refresh-token-value',
      OrganizationFields: { Name: 'acme' },
      SpaceFields: { Name: 'prod' },
    }),
  );
  await writeFile(join(acme, 'hub.json'), JSON.stringify({ label: 'Acme prod', keepAlive: true }));
  return root;
}

async function withService(run: (service: StartedService) => Promise<void>): Promise<void> {
  const root = await makeRoot();
  const service = await startService({
    config: { root, port: 0, keepAliveIntervalMs: 600_000, rescanIntervalMs: 600_000 },
    schedulers: false,
  });
  try {
    await run(service);
  } finally {
    await service.stop();
  }
}

test('the service binds to loopback only', async () => {
  await withService(async (service) => {
    const address = service.app.server.address();
    assert.ok(address && typeof address === 'object');
    assert.equal(address.address, '127.0.0.1');
  });
});

test('GET /api/entries lists every subdirectory with API, org, space and status', async () => {
  await withService(async (service) => {
    const response = await fetch(`${service.url}/api/entries`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { entries: Array<Record<string, unknown>> };
    assert.equal(body.entries.length, 1);
    const entry = body.entries[0]!;
    assert.equal(entry.id, 'acme-prod');
    assert.equal(entry.label, 'Acme prod');
    assert.equal(entry.api, 'https://api.cf.example.com');
    assert.equal(entry.org, 'acme');
    assert.equal(entry.space, 'prod');
    assert.equal(entry.status, 'active');
    assert.equal(entry.keepAlive, true);
    // No token ever leaves the service.
    assert.ok(!JSON.stringify(body).includes('refresh-token-value'));
    assert.ok(!JSON.stringify(body).includes('bearer'));
  });
});

test('GET /api/entries/:id/handoff returns the export line and the CLAUDE.md snippet', async () => {
  await withService(async (service) => {
    const response = await fetch(`${service.url}/api/entries/acme-prod/handoff`);
    const body = (await response.json()) as { cfHome: string; exportLine: string; claudeMdSnippet: string };
    assert.ok(body.cfHome.endsWith('/acme-prod'));
    assert.equal(body.exportLine, `export CF_HOME=${body.cfHome}`);
    assert.ok(body.claudeMdSnippet.includes(body.cfHome));
    assert.ok(body.claudeMdSnippet.includes('Never run `cf login`'));
  });
});

test('POST /api/entries creates a directory with hub.json and rejects bad names', async () => {
  await withService(async (service) => {
    const created = await fetch(`${service.url}/api/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'other-org', api: 'https://api.other.example.com', org: 'o', space: 's' }),
    });
    assert.equal(created.status, 201);
    const { entry } = (await created.json()) as { entry: { path: string; defaultOrg: string } };
    const meta = JSON.parse(await readFile(join(entry.path, 'hub.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(meta.api, 'https://api.other.example.com');
    assert.equal(meta.defaultOrg, 'o');
    assert.equal(entry.defaultOrg, 'o');

    const traversal = await fetch(`${service.url}/api/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '../escape', api: 'https://api.other.example.com' }),
    });
    assert.equal(traversal.status, 400);

    const duplicate = await fetch(`${service.url}/api/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'other-org', api: 'https://api.other.example.com' }),
    });
    assert.equal(duplicate.status, 409);
  });
});

test('an unknown entry answers 404 and a traversal attempt answers 400', async () => {
  await withService(async (service) => {
    assert.equal((await fetch(`${service.url}/api/entries/nope`)).status, 404);
    assert.equal((await fetch(`${service.url}/api/entries/..%2F..%2Fetc`)).status, 400);
  });
});

test('PATCH /api/entries/:id toggles keep-alive and persists it to hub.json', async () => {
  await withService(async (service) => {
    const response = await fetch(`${service.url}/api/entries/acme-prod`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keepAlive: false }),
    });
    assert.equal(response.status, 200);
    const { entry } = (await response.json()) as { entry: { keepAlive: boolean; path: string } };
    assert.equal(entry.keepAlive, false);
    const meta = JSON.parse(await readFile(join(entry.path, 'hub.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(meta.keepAlive, false);
    assert.equal(meta.label, 'Acme prod');
  });
});

test('the event stream opens with a snapshot and then pushes status changes', async () => {
  await withService(async (service) => {
    const controller = new AbortController();
    const response = await fetch(`${service.url}/api/events`, { signal: controller.signal });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const readEvent = async (): Promise<Record<string, unknown>> => {
      let buffer = '';
      while (!buffer.includes('\n\n')) {
        const { value, done } = await reader.read();
        if (done) throw new Error('stream closed');
        buffer += decoder.decode(value, { stream: true });
      }
      const frame = buffer.slice(0, buffer.indexOf('\n\n'));
      const data = frame.split('\n').find((line) => line.startsWith('data: '))!;
      return JSON.parse(data.slice('data: '.length)) as Record<string, unknown>;
    };

    const snapshot = await readEvent();
    assert.equal(snapshot.type, 'entries');

    // A metadata change must reach connected clients without a manual refresh.
    void service.hub.updateEntry('acme-prod', { label: 'Renamed' });
    const update = await readEvent();
    assert.equal(update.type, 'entry');
    assert.equal((update.entry as { label: string }).label, 'Renamed');

    controller.abort();
  });
});

test('the dashboard is served from the same port', async () => {
  await withService(async (service) => {
    const response = await fetch(`${service.url}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('CF Session Hub'));
    assert.equal((await fetch(`${service.url}/app.js`)).status, 200);
  });
});
