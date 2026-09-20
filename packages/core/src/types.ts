/** Shared types for the CF Session Hub core service. */

/** Status of a CF home directory, derived from its cf CLI config. */
export type EntryStatus = 'active' | 'refreshable' | 'expired' | 'unknown';

/** Where an entry is in the SSO passcode flow. */
export type LoginState = 'idle' | 'waiting_passcode' | 'logging_in';

/** Subset of the cf CLI's own `.cf/config.json` that the hub reads. */
export interface CfConfig {
  Target?: string;
  AuthorizationEndpoint?: string;
  UaaEndpoint?: string;
  AccessToken?: string;
  RefreshToken?: string;
  OrganizationFields?: { Name?: string; GUID?: string };
  SpaceFields?: { Name?: string; GUID?: string };
  SSLDisabled?: boolean;
}

/** Optional hub metadata stored next to the cf config, in `<dir>/hub.json`. */
export interface HubMeta {
  label?: string;
  api?: string;
  defaultOrg?: string;
  defaultSpace?: string;
  keepAlive?: boolean;
}

/**
 * An entry as returned by the API. Deliberately free of tokens and passcodes:
 * only expiry timestamps ever leave the service.
 */
export interface Entry {
  id: string;
  label: string;
  path: string;
  api: string | null;
  org: string | null;
  space: string | null;
  defaultOrg: string | null;
  defaultSpace: string | null;
  status: EntryStatus;
  /** Access-token expiry as an ISO timestamp, or null when there is no token. */
  expiresAt: string | null;
  /** Seconds until the access token expires; negative when already expired. */
  expiresInSeconds: number | null;
  hasRefreshToken: boolean;
  keepAlive: boolean;
  loginState: LoginState;
  lastVerifiedAt: string | null;
  lastError: string | null;
}

/** Result of a live check against the CF API for one entry. */
export interface VerifyResult {
  ok: boolean;
  entry: Entry;
  error?: string;
}

/** What the hub hands to Claude Code. */
export interface Handoff {
  id: string;
  cfHome: string;
  exportLine: string;
  claudeMdSnippet: string;
}

/** Events broadcast over `GET /api/events`. */
export type HubEvent =
  | { type: 'entries'; entries: Entry[] }
  | { type: 'entry'; entry: Entry }
  | { type: 'removed'; id: string };
