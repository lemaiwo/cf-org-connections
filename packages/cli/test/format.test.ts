import assert from 'node:assert/strict';
import test from 'node:test';
import type { Entry } from '@cf-session-hub/core';
import { entriesTable, expiry, table } from '../src/format.js';

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'acme-prod',
    label: 'Acme prod',
    path: '/home/u/.cf-homes/acme-prod',
    api: 'https://api.cf.example.com',
    org: 'acme',
    space: 'prod',
    defaultOrg: null,
    defaultSpace: null,
    status: 'active',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    expiresInSeconds: 3600,
    hasRefreshToken: true,
    keepAlive: true,
    loginState: 'idle',
    lastVerifiedAt: null,
    lastError: null,
    ...overrides,
  };
}

test('columns line up regardless of content width', () => {
  const rendered = table(['A', 'BBBB'], [['long-value', 'x']]);
  const [header, rule, row] = rendered.split('\n');
  assert.equal(header, 'A           BBBB');
  assert.equal(rule, '----------  ----');
  assert.equal(row, 'long-value  x');
});

test('the list table shows status, org, space and expiry', () => {
  const rendered = entriesTable([entry(), entry({ id: 'dev', label: 'dev', status: 'expired', expiresAt: null })]);
  assert.match(rendered, /NAME\s+STATUS\s+ORG\s+SPACE\s+EXPIRES\s+API/);
  assert.match(rendered, /Acme prod \(acme-prod\)\s+active\s+acme\s+prod\s+60m/);
  assert.match(rendered, /dev\s+expired/);
});

test('an empty root reads as a sentence, not an empty table', () => {
  assert.equal(entriesTable([]), 'No CF home directories found.');
});

test('expiry renders seconds, minutes and hours', () => {
  assert.equal(expiry(entry({ expiresAt: null })), '-');
  assert.equal(expiry(entry({ expiresAt: new Date(Date.now() - 1000).toISOString() })), 'expired');
  assert.equal(expiry(entry({ expiresAt: new Date(Date.now() + 30_000).toISOString() })), '30s');
  assert.equal(expiry(entry({ expiresAt: new Date(Date.now() + 10 * 3_600_000).toISOString() })), '10h');
});
