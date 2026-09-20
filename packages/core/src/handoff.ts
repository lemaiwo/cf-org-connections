import type { Entry, Handoff } from './types.js';

/** The single line that points a shell (and Claude Code) at an entry. */
export function exportLine(cfHome: string): string {
  return `export CF_HOME=${cfHome}`;
}

/**
 * The CLAUDE.md block to paste into a project. It carries the absolute path and
 * the rule that Claude Code must never authenticate itself: the hub owns login.
 */
export function claudeMdSnippet(cfHome: string): string {
  return [
    '## Cloud Foundry',
    `- Run every cf command with CF_HOME=${cfHome}.`,
    '- The session is already authenticated by CF Session Hub. Never run `cf login`,',
    '  `cf auth` or any SSO flow.',
    '- If a cf command fails with 401 or an authentication error, stop and ask me',
    '  to re-login in CF Session Hub. Do not attempt to authenticate yourself.',
    '',
  ].join('\n');
}

/** Everything the dashboard's two copy buttons need. */
export function buildHandoff(entry: Entry): Handoff {
  return {
    id: entry.id,
    cfHome: entry.path,
    exportLine: exportLine(entry.path),
    claudeMdSnippet: claudeMdSnippet(entry.path),
  };
}
