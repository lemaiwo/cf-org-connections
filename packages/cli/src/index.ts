#!/usr/bin/env node
import { Command } from 'commander';
import type { CfTarget, Entry } from '@cf-session-hub/core';
import { ensureService } from './ensure-service.js';
import { entriesTable, expiry, pickTarget, targetsList } from './format.js';
import { ask } from './prompt.js';
import type { HubClient } from './client.js';

const program = new Command();

program
  .name('cfhub')
  .description('Terminal client for CF Session Hub. Starts the core service when it is not running.')
  .version('0.1.0');

program
  .command('list')
  .alias('ls')
  .description('Show every CF home directory with its status, org/space and expiry')
  .action(async () => {
    const client = await ensureService();
    process.stdout.write(`${entriesTable(await client.listEntries())}\n`);
  });

program
  .command('login')
  .argument('<name>', 'entry name')
  .description('Run the SSO flow: open the browser, then paste the one-time passcode')
  .action(async (name: string) => {
    const client = await ensureService();
    const entry = await resolve(client, name);
    const start = await client.startLogin(entry.id);

    if (start.browserOpened) {
      process.stderr.write(`Opened your browser at ${start.passcodeUrl}\n`);
    } else {
      process.stderr.write(`Open this page and authenticate: ${start.passcodeUrl}\n`);
      if (start.browserError) process.stderr.write(`(${start.browserError})\n`);
    }

    const passcode = await ask('One-time passcode: ');
    if (!passcode) fail('No passcode entered.');

    const result = await client.completeLogin(entry.id, passcode);
    process.stdout.write(
      `${result.label} is ${result.status}` +
        `${result.org ? ` — org ${result.org}` : ''}` +
        `${result.space ? `, space ${result.space}` : ''}\n`,
    );
  });

program
  .command('env')
  .argument('<name>', 'entry name')
  .description('Print the CF_HOME export line, for use with eval $(cfhub env <name>)')
  .action(async (name: string) => {
    const client = await ensureService();
    const entry = await resolve(client, name);
    const handoff = await client.handoff(entry.id);
    // Only the export line goes to stdout, so eval $(cfhub env x) is safe.
    process.stdout.write(`${handoff.exportLine}\n`);
  });

program
  .command('snippet')
  .argument('<name>', 'entry name')
  .description('Print the CLAUDE.md block that points Claude Code at this session')
  .action(async (name: string) => {
    const client = await ensureService();
    const entry = await resolve(client, name);
    const handoff = await client.handoff(entry.id);
    process.stdout.write(handoff.claudeMdSnippet);
  });

program
  .command('verify')
  .argument('[name]', 'entry name; omit to verify every entry')
  .description('Live check against the CF API, which also refreshes the access token')
  .action(async (name?: string) => {
    const client = await ensureService();
    const targets = name ? [await resolve(client, name)] : await client.listEntries();
    if (targets.length === 0) {
      process.stdout.write('No CF home directories found.\n');
      return;
    }
    let failures = 0;
    for (const target of targets) {
      const result = await client.verify(target.id);
      if (result.ok) {
        process.stdout.write(`ok      ${target.label}  (${expiry(result.entry)} left)\n`);
      } else {
        failures += 1;
        process.stdout.write(`FAILED  ${target.label}  ${result.error ?? 'session unusable'}\n`);
      }
    }
    if (failures > 0) process.exitCode = 1;
  });

program
  .command('orgs')
  .argument('<name>', 'entry name')
  .description('List the organizations this entry can see, marking the current one')
  .action(async (name: string) => {
    const client = await ensureService();
    const entry = await resolve(client, name);
    const orgs = await client.listOrgs(entry.id);
    process.stdout.write(`${targetsList(orgs, entry.org ?? entry.defaultOrg)}\n`);
  });

program
  .command('target')
  .argument('<name>', 'entry name')
  .option('-o, --org <org>', 'organization to switch to')
  .option('-s, --space <space>', 'space to switch to')
  .description('Switch an entry to another org and space, and remember it as the default')
  .action(async (name: string, options: { org?: string; space?: string }) => {
    const client = await ensureService();
    const entry = await resolve(client, name);

    const org = options.org
      ? { guid: '', name: options.org }
      : await choose(await client.listOrgs(entry.id), entry.org ?? entry.defaultOrg, 'organization');

    // Only the interactive path offers spaces: passing -o without -s stays a
    // plain org switch, so the command never blocks a script on a prompt.
    let space = options.space ?? null;
    if (space === null && org.guid) {
      const spaces = await client.listSpaces(entry.id, org.guid);
      space = spaces.length === 0 ? null : (await choose(spaces, entry.space, 'space')).name;
    }

    const updated = await client.setTarget(entry.id, org.name, space);
    process.stdout.write(
      `${updated.label} → org ${updated.org ?? org.name}` +
        `${updated.space ? `, space ${updated.space}` : ''}\n`,
    );
  });

/** Shows a numbered list and reads one choice, re-prompting once on a miss. */
async function choose(items: CfTarget[], current: string | null, what: string): Promise<CfTarget> {
  if (items.length === 0) fail(`No ${what} available for this entry.`);
  process.stderr.write(`${targetsList(items, current)}\n`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const picked = pickTarget(items, await ask(`Choose a ${what} (number or name): `));
    if (picked) return picked;
    process.stderr.write(`Not one of the listed ${what}s.\n`);
  }
  return fail(`No ${what} chosen.`);
}

program
  .command('logout')
  .argument('<name>', 'entry name')
  .description('Log the entry out')
  .action(async (name: string) => {
    const client = await ensureService();
    const entry = await resolve(client, name);
    await client.logout(entry.id);
    process.stdout.write(`${entry.label} logged out\n`);
  });

program
  .command('serve')
  .description('Make sure the core service is running and print the dashboard URL')
  .action(async () => {
    const client = await ensureService();
    const health = await client.health();
    process.stdout.write(`CF Session Hub is running on ${client.baseUrl} (root ${health.root})\n`);
  });

/** Resolves a user-typed name against entry ids first, then labels. */
async function resolve(client: HubClient, name: string): Promise<Entry> {
  const entries = await client.listEntries();
  const byId = entries.find((entry) => entry.id === name);
  if (byId) return byId;
  const matches = entries.filter(
    (entry) => entry.label.toLowerCase() === name.toLowerCase() || entry.id.toLowerCase() === name.toLowerCase(),
  );
  if (matches.length === 1 && matches[0]) return matches[0];
  if (matches.length > 1) {
    fail(`${name} matches several entries: ${matches.map((entry) => entry.id).join(', ')}`);
  }
  const known = entries.map((entry) => entry.id).join(', ') || 'none';
  return fail(`No entry named ${name}. Known entries: ${known}`);
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Exiting is left to the event loop. Calling process.exit() here aborts on
 * Windows — the fetch keep-alive socket is still closing, and libuv asserts on
 * the handle — so the exit code is set and the process ends on its own.
 */
program.parseAsync(process.argv).catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
