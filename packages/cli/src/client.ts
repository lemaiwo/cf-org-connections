import type { CfTarget, Entry, Handoff } from '@cf-session-hub/core';

export interface LoginStartResponse {
  entry: Entry;
  state: string;
  passcodeUrl: string;
  browserOpened: boolean;
  browserError: string | null;
}

/** Thin HTTP client over the core service's REST API. */
export class HubClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        // Only declare a JSON body when there actually is one.
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as unknown) : {};
    if (!response.ok) {
      const message =
        payload && typeof payload === 'object' && 'error' in payload
          ? String((payload as { error: unknown }).error)
          : `Request failed (${response.status})`;
      throw new Error(message);
    }
    return payload as T;
  }

  async health(): Promise<{ ok: boolean; root: string; port: number }> {
    return this.#request('/api/health');
  }

  async listEntries(): Promise<Entry[]> {
    const { entries } = await this.#request<{ entries: Entry[] }>('/api/entries');
    return entries;
  }

  async getEntry(id: string): Promise<Entry> {
    const { entry } = await this.#request<{ entry: Entry }>(`/api/entries/${encodeURIComponent(id)}`);
    return entry;
  }

  async startLogin(id: string): Promise<LoginStartResponse> {
    return this.#request(`/api/entries/${encodeURIComponent(id)}/login/start`, { method: 'POST' });
  }

  async completeLogin(id: string, passcode: string): Promise<Entry> {
    const { entry } = await this.#request<{ entry: Entry }>(
      `/api/entries/${encodeURIComponent(id)}/login/complete`,
      { method: 'POST', body: JSON.stringify({ passcode }) },
    );
    return entry;
  }

  async verify(id: string): Promise<{ ok: boolean; entry: Entry; error: string | null }> {
    return this.#request(`/api/entries/${encodeURIComponent(id)}/verify`, { method: 'POST' });
  }

  async logout(id: string): Promise<Entry> {
    const { entry } = await this.#request<{ entry: Entry }>(
      `/api/entries/${encodeURIComponent(id)}/logout`,
      { method: 'POST' },
    );
    return entry;
  }

  async handoff(id: string): Promise<Handoff> {
    return this.#request(`/api/entries/${encodeURIComponent(id)}/handoff`);
  }

  async listOrgs(id: string): Promise<CfTarget[]> {
    const { orgs } = await this.#request<{ orgs: CfTarget[] }>(
      `/api/entries/${encodeURIComponent(id)}/orgs`,
    );
    return orgs;
  }

  async listSpaces(id: string, orgGuid: string): Promise<CfTarget[]> {
    const { spaces } = await this.#request<{ spaces: CfTarget[] }>(
      `/api/entries/${encodeURIComponent(id)}/spaces?org=${encodeURIComponent(orgGuid)}`,
    );
    return spaces;
  }

  async setTarget(id: string, org: string, space: string | null): Promise<Entry> {
    const { entry } = await this.#request<{ entry: Entry }>(
      `/api/entries/${encodeURIComponent(id)}/target`,
      { method: 'POST', body: JSON.stringify({ org, space }) },
    );
    return entry;
  }
}
