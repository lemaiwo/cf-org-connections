/**
 * Minimal JWT payload reader. The hub only needs the `exp` claim to show an
 * expiry countdown; it never validates signatures (the cf CLI and UAA do that)
 * and never returns the token itself.
 */

interface JwtPayload {
  exp?: number;
  [key: string]: unknown;
}

/**
 * Decodes the payload of a JWT. Accepts the `bearer <token>` form the cf CLI
 * stores in `config.json`. Returns null for anything that is not a readable
 * three-part JWT.
 */
export function decodeJwtPayload(token: string | undefined | null): JwtPayload | null {
  if (!token) return null;
  const bare = token.replace(/^bearer\s+/i, '').trim();
  const parts = bare.split('.');
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (!payload) return null;
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Returns the token's expiry in milliseconds since the epoch, or null when the
 * token is missing, unreadable or carries no numeric `exp`.
 */
export function tokenExpiryMs(token: string | undefined | null): number | null {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
    return null;
  }
  return payload.exp * 1000;
}
