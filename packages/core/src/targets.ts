import { cfErrorMessage, runCf } from './cf.js';
import type { CfTarget } from './types.js';

/** Page size for the v3 list endpoints. */
const PER_PAGE = 200;
/** Safety stop: a landscape deeper than this is not worth walking page by page. */
const MAX_PAGES = 10;

/** A listing that could not be read. Carries a message fit for the UI. */
export class CfListError extends Error {}

export interface TargetPage {
  items: CfTarget[];
  /** Path of the next page, or null when this was the last one. */
  next: string | null;
}

export function orgsPath(): string {
  return `/v3/organizations?per_page=${PER_PAGE}&order_by=name`;
}

export function spacesPath(orgGuid: string): string {
  return `/v3/spaces?organization_guids=${encodeURIComponent(orgGuid)}&per_page=${PER_PAGE}&order_by=name`;
}

/** The cf CLI arguments that move an entry to an org, and optionally a space. */
export function targetArgs(org: string, space: string | null): string[] {
  const args = ['target', '-o', org];
  const trimmed = space?.trim();
  if (trimmed) args.push('-s', trimmed);
  return args;
}

/**
 * Reads one page of a v3 listing.
 *
 * `cf curl` exits 0 even when it cannot authenticate — it simply prints
 * nothing — so an empty body is treated as a dead session rather than as an
 * empty list. Reporting "this org has no spaces" for an expired session would
 * be worse than reporting nothing at all.
 */
export function parseTargetPage(stdout: string, what: string): TargetPage {
  if (!stdout.trim()) {
    throw new CfListError(
      `Could not read ${what}: the cf CLI returned nothing, which usually means the session can no longer be refreshed. Log in again.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CfListError(`Could not read ${what}: the cf CLI returned output that is not JSON.`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new CfListError(`Could not read ${what}: the cf CLI returned output that is not JSON.`);
  }

  const body = parsed as {
    errors?: Array<{ detail?: string; title?: string } | null>;
    resources?: unknown;
    pagination?: { next?: { href?: string } | null } | null;
  };

  if (Array.isArray(body.errors) && body.errors.length > 0) {
    const first = body.errors[0];
    throw new CfListError(
      first?.detail || first?.title || `The CF API rejected the ${what} request.`,
    );
  }

  const resources = Array.isArray(body.resources) ? body.resources : [];
  const items: CfTarget[] = [];
  for (const resource of resources) {
    if (!resource || typeof resource !== 'object') continue;
    const { guid, name } = resource as { guid?: unknown; name?: unknown };
    if (typeof guid === 'string' && guid && typeof name === 'string' && name) {
      items.push({ guid, name });
    }
  }

  return { items, next: nextPath(body.pagination?.next?.href) };
}

/** `cf curl` takes a path, so the next-page URL is reduced to one. */
function nextPath(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return `${url.pathname}${url.search}`;
  } catch {
    return href.startsWith('/') ? href : null;
  }
}

/** Walks a v3 listing to the end, one `cf curl` per page. */
async function listTargets(cfHome: string, firstPath: string, what: string): Promise<CfTarget[]> {
  const items: CfTarget[] = [];
  let path: string | null = firstPath;
  for (let page = 0; page < MAX_PAGES && path !== null; page += 1) {
    const result = await runCf(['curl', path], { cfHome, timeoutMs: 45_000 });
    if (result.code !== 0) {
      throw new CfListError(cfErrorMessage(result, `Could not read ${what}.`));
    }
    const parsed = parseTargetPage(result.stdout, what);
    items.push(...parsed.items);
    path = parsed.next;
  }
  return items;
}

export async function listOrgs(cfHome: string): Promise<CfTarget[]> {
  return listTargets(cfHome, orgsPath(), 'organizations');
}

export async function listSpaces(cfHome: string, orgGuid: string): Promise<CfTarget[]> {
  return listTargets(cfHome, spacesPath(orgGuid), 'spaces');
}
