import assert from 'node:assert/strict';
import test from 'node:test';
import type { CfTarget } from '@cf-session-hub/core';
import { pickTarget, targetsList } from '../src/format.js';

const orgs: CfTarget[] = [
  { guid: 'g1', name: 'acme-org' },
  { guid: 'g2', name: 'beta-org' },
  { guid: 'g3', name: 'gamma-org' },
];

test('the numbered list marks the one currently targeted', () => {
  const rendered = targetsList(orgs, 'beta-org');
  assert.deepEqual(rendered.split('\n'), [
    '  1  acme-org',
    '* 2  beta-org',
    '  3  gamma-org',
  ]);
});

test('with nothing targeted no line is marked', () => {
  const rendered = targetsList(orgs, null);
  assert.ok(!rendered.includes('*'));
  assert.match(rendered, /1 {2}acme-org/);
});

test('an empty list says so rather than rendering nothing', () => {
  assert.match(targetsList([], null), /none/i);
});

test('a typed number picks that line', () => {
  assert.deepEqual(pickTarget(orgs, '2'), { guid: 'g2', name: 'beta-org' });
  assert.deepEqual(pickTarget(orgs, ' 3 '), { guid: 'g3', name: 'gamma-org' });
});

test('a typed name picks it, ignoring case', () => {
  assert.deepEqual(pickTarget(orgs, 'ACME-org'), { guid: 'g1', name: 'acme-org' });
});

test('a number outside the list picks nothing', () => {
  assert.equal(pickTarget(orgs, '0'), null);
  assert.equal(pickTarget(orgs, '4'), null);
  assert.equal(pickTarget(orgs, '-1'), null);
});

test('an unknown name or empty answer picks nothing', () => {
  assert.equal(pickTarget(orgs, 'nope'), null);
  assert.equal(pickTarget(orgs, ''), null);
  assert.equal(pickTarget(orgs, '   '), null);
});

test('a name that looks like a number is matched as a name first', () => {
  const numeric: CfTarget[] = [
    { guid: 'a', name: 'alpha' },
    { guid: 'b', name: '1' },
  ];
  // "1" is both the first line and the literal name of the second entry; the
  // name is the more specific match.
  assert.deepEqual(pickTarget(numeric, '1'), { guid: 'b', name: '1' });
});

test('the name column stays aligned past nine entries', () => {
  const many: CfTarget[] = Array.from({ length: 12 }, (_, index) => ({
    guid: `g${index}`,
    name: `org-${index}`,
  }));
  const offsets = new Set(targetsList(many, null).split('\n').map((line) => line.indexOf('org-')));
  assert.equal(offsets.size, 1, 'every name should start at the same column');
});
