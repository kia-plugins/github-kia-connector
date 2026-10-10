import { SourceAuthError } from '@kiagent/connector-sdk';
import type { HostFor } from '@kiagent/connector-sdk';

export type NetFetch = HostFor<'net'>['net']['fetch'];
type PluginNetInit = NonNullable<Parameters<NetFetch>[1]>;
type PluginNetResult = Awaited<ReturnType<NetFetch>>;

/** The single place that talks to GitHub and owns the WHOLE retry ladder
 *  (spec §6.4) — the SDK's requestWithRetry clamps 429 and cannot tell a
 *  secondary-limit 403 from an auth 403, so it is deliberately not used. */

/** SAML SSO enforcement on an org the token is not authorized for. */
export class OrgBlockedError extends Error {
  constructor(public url?: string) {
    super(`github: SSO authorization required${url ? ` (${url})` : ''}`);
  }
}
export class NotFoundError extends Error {}
export class InsufficientScopesError extends Error {}

export interface GhCommit {
  sha: string;
  author: { login: string } | null;
  commit: { message: string; author: { name: string; email: string; date: string } };
}

const API = 'https://api.github.com';
const MAX_SECONDARY = 3;
const MAX_TRANSIENT = 4;
const RESET_CAP_MS = 60 * 60 * 1000;

interface Deps {
  fetch: NetFetch;
  token: string;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  log?: (m: string) => void;
  now?: () => number;
}

const defaultSleep = (signal?: AbortSignal) => (ms: number) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });

function lower(h: Record<string, string>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) o[k.toLowerCase()] = v;
  return o;
}

const NEXT = /<([^>]+)>;\s*rel="next"/;

export class GitHubClient {
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private warnedPartial = false;

  constructor(private deps: Deps) {
    this.sleep = deps.sleep ?? defaultSleep(deps.signal);
    this.now = deps.now ?? Date.now;
  }

  /** One request through the classification ladder. Returns parsed JSON. */
  private async request(url: string, init: PluginNetInit = {}, graphql = false): Promise<{ data: unknown; headers: Record<string, string> }> {
    let secondary = 0;
    let transient = 0;
    for (;;) {
      if (this.deps.signal?.aborted) throw new Error('aborted');
      let res: PluginNetResult;
      try {
        res = await this.deps.fetch(url, {
          ...init,
          signal: this.deps.signal,
          headers: {
            Authorization: `Bearer ${this.deps.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'kia-github-connector',
            ...(init.headers ?? {}),
          },
        });
      } catch (e) {
        if (this.deps.signal?.aborted || ++transient > MAX_TRANSIENT) throw e;
        await this.sleep(2000 * 2 ** (transient - 1));
        continue;
      }
      const headers = lower(res.headers);
      const text = new TextDecoder().decode(res.body);
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      const message = String(body?.message ?? '') + ' ' + (Array.isArray(body?.errors) ? body.errors.map((e: any) => e?.message ?? '').join(' ') : '');
      const gqlTypes: string[] = graphql && Array.isArray(body?.errors) ? body.errors.map((e: any) => e?.type) : [];
      const isSecondary = /secondary rate limit/i.test(message) || ((res.status === 403 || res.status === 429) && headers['retry-after'] != null);
      const isPrimary =
        !isSecondary &&
        (((res.status === 403 || res.status === 429) && headers['x-ratelimit-remaining'] === '0') || gqlTypes.includes('RATE_LIMITED'));

      // 1. secondary limit
      if (isSecondary) {
        if (++secondary > MAX_SECONDARY) throw new Error(`github: secondary rate limit persisted (${url})`);
        const ra = Number(headers['retry-after']);
        const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000 * 2 ** (secondary - 1);
        this.deps.log?.(`github: secondary rate limit, waiting ${Math.round(wait / 1000)}s`);
        await this.sleep(wait);
        continue;
      }
      // 2. primary limit
      if (isPrimary) {
        const reset = Number(headers['x-ratelimit-reset']) * 1000;
        const wait = Number.isFinite(reset) ? Math.min(Math.max(reset - this.now(), 1000), RESET_CAP_MS) : 60_000;
        this.deps.log?.(`github: rate limit exhausted, waiting ${Math.round(wait / 1000)}s`);
        await this.sleep(wait);
        continue;
      }
      // 3. SSO
      const sso = headers['x-github-sso'];
      if (sso && (res.status === 403 || res.status === 404) && /^required/.test(sso)) {
        throw new OrgBlockedError(/url=(\S+)/.exec(sso)?.[1]);
      }
      if (sso && /^partial-results/.test(sso) && !this.warnedPartial) {
        this.warnedPartial = true;
        this.deps.log?.(`github: some organizations require SSO authorization (${sso})`);
      }
      // 4. auth
      if (res.status === 401 || res.status === 403) {
        throw new SourceAuthError(`github: ${res.status} ${message.trim() || 'forbidden'} (${url})`);
      }
      // 5. not found / empty
      if (res.status === 404) throw new NotFoundError(`github: 404 ${url}`);
      if (res.status === 409) return { data: [], headers };
      // 6. transient
      if (res.status >= 500) {
        if (++transient > MAX_TRANSIENT) throw new Error(`github: ${res.status} ${url}`);
        await this.sleep(2000 * 2 ** (transient - 1));
        continue;
      }
      if (res.status >= 400) throw new Error(`github: ${res.status} ${message.trim()} (${url})`);
      if (gqlTypes.includes('INSUFFICIENT_SCOPES')) throw new InsufficientScopesError(message.trim());
      return { data: body, headers };
    }
  }

  private url(path: string, query?: Record<string, string | number>): string {
    const u = new URL(path.startsWith('http') ? path : API + path);
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async rest<T>(path: string, query?: Record<string, string | number>): Promise<{ data: T; headers: Record<string, string> }> {
    const r = await this.request(this.url(path, query));
    return { data: r.data as T, headers: r.headers };
  }

  /** Follows Link rel=next. */
  async *restPages<T>(path: string, query?: Record<string, string | number>, maxPages = Infinity): AsyncGenerator<{ data: T[]; headers: Record<string, string> }> {
    let next: string | null = this.url(path, { per_page: 100, ...(query ?? {}) });
    for (let page = 0; next && page < maxPages; page++) {
      const r = await this.request(next);
      // /search/* answers with an envelope { total_count, items }.
      const raw = r.data as { items?: unknown; incomplete_results?: boolean } | unknown[] | null;
      // A timed-out search returns a partial page: never checkpoint on it.
      if (raw && !Array.isArray(raw) && raw.incomplete_results === true) throw new Error('github: incomplete search results, retrying later');
      const data = (Array.isArray(raw) ? raw : Array.isArray((raw as { items?: unknown })?.items) ? (raw as { items: unknown[] }).items : []) as T[];
      yield { data, headers: r.headers };
      next = NEXT.exec(r.headers['link'] ?? '')?.[1] ?? null;
    }
  }

  /** Compare is an envelope; page with per_page/page until a short page. */
  async *compareCommits(repo: string, base: string, head: string): AsyncGenerator<GhCommit[]> {
    for (let page = 1; ; page++) {
      const r = await this.request(this.url(`/repos/${repo}/compare/${base}...${head}`, { per_page: 100, page }));
      const commits = ((r.data as { commits?: GhCommit[] } | null)?.commits ?? []) as GhCommit[];
      if (commits.length) yield commits;
      if (commits.length < 100) return;
    }
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const r = await this.request(API + '/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) }, true);
    const body = r.data as { data?: T | null; errors?: { type?: string; message?: string }[] } | null;
    const errors = body?.errors ?? [];
    // Partial data is normal for aliased queries: a blocked or deleted
    // repo is a null alias next to healthy ones — callers skip nulls.
    if (errors.length && body?.data == null) {
      if (errors.some((e) => e.type === 'FORBIDDEN' && /SAML/i.test(e.message ?? ''))) throw new OrgBlockedError();
      if (errors.some((e) => e.type === 'NOT_FOUND')) throw new NotFoundError(errors[0].message ?? 'not found');
      throw new Error(`github graphql: ${errors.map((e) => e.message).join('; ')}`);
    }
    return body?.data as T;
  }
}
