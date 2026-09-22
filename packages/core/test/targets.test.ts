import assert from 'node:assert/strict';
import test from 'node:test';
import { orgsPath, parseTargetPage, spacesPath, targetArgs } from '../src/targets.js';

function page(body: unknown): string {
  return JSON.stringify(body);
}

test('a v3 list page yields every name and guid, in order', () => {
  const result = parseTargetPage(
    page({
      pagination: { next: null },
      resources: [
        { guid: 'g1', name: 'acme' },
        { guid: 'g2', name: 'beta' },
      ],
    }),
    'organizations',
  );
  assert.deepEqual(result.items, [
    { guid: 'g1', name: 'acme' },
    { guid: 'g2', name: 'beta' },
  ]);
  assert.equal(result.next, null);
});

test('the next page is reduced to a path, because cf curl takes a path', () => {
  const result = parseTargetPage(
    page({
      pagination: { next: { href: 'https://api.cf.example.com/v3/spaces?page=2&per_page=200' } },
      resources: [],
    }),
    'spaces',
  );
  assert.equal(result.next, '/v3/spaces?page=2&per_page=200');
});

test('an empty response is a dead session, not an empty list', () => {
  // `cf curl` exits 0 and prints nothing when the session can no longer be
  // refreshed, so an empty body must never read as "this org has no spaces".
  assert.throws(() => parseTargetPage('', 'organizations'), /log in again/i);
  assert.throws(() => parseTargetPage('   \n', 'organizations'), /log in again/i);
});

test('a CF error document surfaces the API message', () => {
  assert.throws(
    () =>
      parseTargetPage(
        page({ errors: [{ detail: 'Invalid Auth Token', title: 'CF-InvalidAuthToken' }] }),
        'organizations',
      ),
    /Invalid Auth Token/,
  );
});

test('an error document with only a title still produces a message', () => {
  assert.throws(
    () => parseTargetPage(page({ errors: [{ title: 'CF-NotAuthorized' }] }), 'spaces'),
    /CF-NotAuthorized/,
  );
});

test('output that is not JSON at all is reported, not thrown raw', () => {
  assert.throws(() => parseTargetPage('<html>502 Bad Gateway</html>', 'organizations'), /organizations/);
});

test('no resources is a legitimate empty list', () => {
  const result = parseTargetPage(page({ pagination: { next: null }, resources: [] }), 'spaces');
  assert.deepEqual(result.items, []);
  assert.equal(result.next, null);
});

test('resources missing a name or guid are skipped', () => {
  const result = parseTargetPage(
    page({
      resources: [{ guid: 'g1' }, { name: 'nameless' }, { guid: 'g2', name: 'ok' }, null],
    }),
    'organizations',
  );
  assert.deepEqual(result.items, [{ guid: 'g2', name: 'ok' }]);
});

test('the orgs query asks for names in order', () => {
  const path = orgsPath();
  assert.match(path, /^\/v3\/organizations\?/);
  assert.match(path, /order_by=name/);
  assert.match(path, /per_page=\d+/);
});

test('the spaces query is filtered to one organization, url-encoded', () => {
  const path = spacesPath('a guid/with&chars');
  assert.match(path, /^\/v3\/spaces\?/);
  assert.match(path, /organization_guids=a%20guid%2Fwith%26chars/);
  assert.match(path, /order_by=name/);
});

test('targeting an org and a space passes both to the cf CLI', () => {
  assert.deepEqual(targetArgs('acme', 'prod'), ['target', '-o', 'acme', '-s', 'prod']);
});

test('targeting an org alone omits the space flag', () => {
  assert.deepEqual(targetArgs('acme', null), ['target', '-o', 'acme']);
  assert.deepEqual(targetArgs('acme', '   '), ['target', '-o', 'acme']);
});
