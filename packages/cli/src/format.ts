import type { Entry } from '@cf-session-hub/core';

/** Renders a plain, dependency-free table. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd();
  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)].join('\n');
}

/** Human-readable time left on the access token. */
export function expiry(entry: Entry): string {
  if (entry.expiresAt === null) return '-';
  const seconds = Math.round((new Date(entry.expiresAt).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return 'expired';
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

export function entriesTable(entries: Entry[]): string {
  if (entries.length === 0) return 'No CF home directories found.';
  return table(
    ['NAME', 'STATUS', 'ORG', 'SPACE', 'EXPIRES', 'API'],
    entries.map((entry) => [
      entry.label === entry.id ? entry.id : `${entry.label} (${entry.id})`,
      entry.status,
      entry.org ?? entry.defaultOrg ?? '-',
      entry.space ?? entry.defaultSpace ?? '-',
      expiry(entry),
      entry.api ?? '-',
    ]),
  );
}
