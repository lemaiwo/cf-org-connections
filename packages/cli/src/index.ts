#!/usr/bin/env node
import { Command } from 'commander';
import type { Entry } from '@cf-session-hub/core';
import { ensureService } from './ensure-service.js';
import { entriesTable, expiry } from './format.js';
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
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

program.parseAsync(process.argv).catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
