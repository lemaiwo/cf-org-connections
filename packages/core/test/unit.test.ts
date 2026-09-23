import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveStatus, buildEntry, isValidEntryId, ACTIVE_MARGIN_MS, emptyRuntime } from '../src/entries.js';
import { decodeJwtPayload, tokenExpiryMs } from '../src/jwt.js';
import { redactSecrets } from '../src/cf.js';
import { claudeMdSnippet, exportLine, buildHandoff } from '../src/handoff.js';
import { isValidPasscode, passcodeUrl, resolveLoginEndpoint } from '../src/login.js';
import type { CfConfig } from '../src/types.js';

/** Builds an unsigned JWT with the given expiry, as the cf CLI would store it. */
function jwt(expSeconds: number): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `bearer ${encode({ alg: 'none' })}.${encode({ exp: expSeconds })}.signature`;
}

test('decodes the exp claim from a bearer-prefixed token', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(decodeJwtPayload(jwt(exp))?.exp, exp);
  assert.equal(tokenExpiryMs(jwt(exp)), exp * 1000);
});

test('unreadable tokens decode to null rather than throwing', () => {
  assert.equal(decodeJwtPayload(undefined), null);
  assert.equal(decodeJwtPayload('not-a-jwt'), null);
  assert.equal(tokenExpiryMs('a.b.c'), null);
});

test('status is active only while the token has more than five minutes left', () => {
  const now = Date.now();
  const farFuture = Math.floor((now + ACTIVE_MARGIN_MS + 60_000) / 1000);
  const soon = Math.floor((now + 60_000) / 1000);

  assert.equal(deriveStatus({ AccessToken: jwt(farFuture) }, now), 'active');
  assert.equal(deriveStatus({ AccessToken: jwt(soon), RefreshToken: 'r' }, now), 'refreshable');
  assert.equal(deriveStatus({ AccessToken: jwt(soon) }, now), 'expired');
});

test('an expired token with a refresh token is refreshable, without one it is expired', () => {
  const now = Date.now();
  const past = Math.floor((now - 60_000) / 1000);
  assert.equal(deriveStatus({ AccessToken: jwt(past), RefreshToken: 'r' }, now), 'refreshable');
  assert.equal(deriveStatus({ AccessToken: jwt(past), Target: 'https://api.example.com' }, now), 'expired');
});

test('a missing or empty cf config reads as unknown', () => {
  assert.equal(deriveStatus(null), 'unknown');
  assert.equal(deriveStatus({}), 'unknown');
});

test('entry ids cannot escape the root folder', () => {
  assert.equal(isValidEntryId('acme-prod'), true);
  assert.equal(isValidEntryId('acme.prod_1'), true);
  assert.equal(isValidEntryId('..'), false);
  assert.equal(isValidEntryId('../etc'), false);
  assert.equal(isValidEntryId('a/b'), false);
  assert.equal(isValidEntryId(''), false);
  assert.equal(isValidEntryId('.hidden'), false);
});

test('the API representation of an entry carries no tokens', () => {
  const now = Date.now();
  const exp = Math.floor((now + 3_600_000) / 1000);
  const config: CfConfig = {
    Target: 'https://api.cf.example.com',
    AccessToken: jwt(exp),
    RefreshToken: 'super-secret-refresh-token',
    OrganizationFields: { Name: 'acme' },
    SpaceFields: { Name: 'prod' },
  };
  const entry = buildEntry('acme', '/home/u/.cf-homes/acme', config, { label: 'Acme prod' }, emptyRuntime(), now);

  const serialized = JSON.stringify(entry);
  assert.ok(!serialized.includes('super-secret-refresh-token'));
  assert.ok(!serialized.includes('bearer'));
  assert.equal(entry.hasRefreshToken, true);
  assert.equal(entry.status, 'active');
  assert.equal(entry.org, 'acme');
  assert.equal(entry.space, 'prod');
  assert.equal(entry.label, 'Acme prod');
  assert.equal(entry.expiresAt, new Date(exp * 1000).toISOString());
});

test('secrets are stripped from cf output', () => {
  const token = 'eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE3MDAwMDAwMDB9.abcdefghijklmnop';
  const text = `Using token ${token} and passcode --sso-passcode ABC123XYZ for "AccessToken": "${token}"`;
  const redacted = redactSecrets(text, ['ABC123XYZ']);
  assert.ok(!redacted.includes(token));
  assert.ok(!redacted.includes('ABC123XYZ'));
  assert.ok(redacted.includes('[redacted]'));
});

test('the handoff snippet has the absolute path and the no-login rule', () => {
  const path = '/home/u/.cf-homes/acme';
  assert.equal(exportLine(path), `export CF_HOME=${path}`);
  const snippet = claudeMdSnippet(path);
  assert.ok(snippet.includes(path));
  assert.ok(snippet.includes('Never run `cf login`'));
  assert.ok(snippet.includes('## Cloud Foundry'));

  const handoff = buildHandoff(
    buildEntry('acme', path, null, {}, emptyRuntime()),
  );
  assert.equal(handoff.cfHome, path);
  assert.equal(handoff.exportLine, `export CF_HOME=${path}`);
});

test('the login endpoint comes from the cf config when it is there', async () => {
  const endpoint = await resolveLoginEndpoint(
    { AuthorizationEndpoint: 'https://login.cf.example.com/' },
    'https://api.cf.example.com',
  );
  assert.equal(endpoint, 'https://login.cf.example.com');
  assert.equal(passcodeUrl(endpoint), 'https://login.cf.example.com/passcode');
});

test('the login endpoint otherwise comes from the API root info', async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ links: { login: { href: 'https://uaa.cf.example.com' } } }),
    };
  }) as unknown as typeof fetch;

  const endpoint = await resolveLoginEndpoint(null, 'https://api.cf.example.com', fakeFetch);
  assert.deepEqual(calls, ['https://api.cf.example.com/']);
  assert.equal(passcodeUrl(endpoint), 'https://uaa.cf.example.com/passcode');
});

test('a missing API endpoint is a clear error, not a crash', async () => {
  await assert.rejects(() => resolveLoginEndpoint(null, null), /No API endpoint known/);
});

test('passcodes are validated before they reach the cf CLI', () => {
  assert.equal(isValidPasscode('AbC123-_.~'), true);
  assert.equal(isValidPasscode('short'), true);
  assert.equal(isValidPasscode('abc'), false);
  assert.equal(isValidPasscode('code; rm -rf /'), false);
  assert.equal(isValidPasscode('$(whoami)'), false);
  assert.equal(isValidPasscode(42), false);
});
