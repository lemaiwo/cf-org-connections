import { safeUrl } from './browser.js';
import type { CfConfig } from './types.js';

/** Thrown when the hub cannot work out where UAA lives for an entry. */
export class LoginEndpointError extends Error {}

/**
 * Resolves the UAA login endpoint for an entry:
 * 1. `AuthorizationEndpoint` (or `UaaEndpoint`) from the cf config, when present;
 * 2. otherwise `GET <api>/v3/info` and read `links.login.href`.
 */
export async function resolveLoginEndpoint(
  config: CfConfig | null,
  api: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const fromConfig = config?.AuthorizationEndpoint || config?.UaaEndpoint;
  if (fromConfig && safeUrl(fromConfig)) return stripTrailingSlash(fromConfig);

  if (!api) {
    throw new LoginEndpointError(
      'No API endpoint known for this entry. Set one in hub.json or recreate the entry.',
    );
  }
  const apiUrl = safeUrl(api);
  if (!apiUrl) {
    throw new LoginEndpointError(`Not a valid API endpoint: ${api}`);
  }

  let body: unknown;
  try {
    const response = await fetchImpl(`${stripTrailingSlash(apiUrl.toString())}/v3/info`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new LoginEndpointError(
        `The CF API answered ${response.status} for /v3/info; cannot resolve the login endpoint.`,
      );
    }
    body = await response.json();
  } catch (error) {
    if (error instanceof LoginEndpointError) throw error;
    throw new LoginEndpointError(
      `Could not reach ${apiUrl.host} to resolve the login endpoint: ${(error as Error).message}`,
    );
  }

  const href = readLoginHref(body);
  if (!href || !safeUrl(href)) {
    throw new LoginEndpointError('The CF API did not report a login endpoint in /v3/info.');
  }
  return stripTrailingSlash(href);
}

/** `<login endpoint>/passcode` — the one-time passcode page the user visits. */
export function passcodeUrl(loginEndpoint: string): string {
  return `${stripTrailingSlash(loginEndpoint)}/passcode`;
}

/** A passcode is a short opaque string; reject anything that looks like a shell argument. */
export function isValidPasscode(passcode: unknown): passcode is string {
  return typeof passcode === 'string' && /^[A-Za-z0-9._~-]{4,256}$/.test(passcode.trim());
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function readLoginHref(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const links = (body as { links?: unknown }).links;
  if (!links || typeof links !== 'object') return null;
  const login = (links as { login?: unknown }).login;
  if (!login || typeof login !== 'object') return null;
  const href = (login as { href?: unknown }).href;
  return typeof href === 'string' ? href : null;
}
