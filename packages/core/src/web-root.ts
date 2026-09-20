import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locates the dashboard's static assets. Resolves the `@cf-session-hub/web`
 * package first and falls back to the workspace layout, so a checkout without
 * a linked workspace still serves the dashboard.
 */
export function resolveWebRoot(): string | null {
  const require = createRequire(import.meta.url);
  try {
    const indexPath = require.resolve('@cf-session-hub/web/public/index.html');
    if (existsSync(indexPath)) return dirname(indexPath);
  } catch {
    // Not installed as a dependency; try the workspace layout below.
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../web/public'), // dist/src -> packages/web/public
    resolve(here, '../../web/public'),
  ];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'index.html'))) return candidate;
  }
  return null;
}
