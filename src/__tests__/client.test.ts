import { GitHubClient, NotFoundError, InsufficientScopesError, OrgBlockedError } from '../client';

const enc = new TextEncoder();
const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => ({
  status,
  statusText: '',
  headers,
  body: enc.encode(typeof body === 'string' ? body : JSON.stringify(body)),
});
type R = ReturnType<typeof res>;

function client(script: R[], now = 1_000_000_000_000) {
  const sleeps: number[] = [];
  const urls: string[] = [];
  const c = new GitHubClient({
    token: 't',
    now: () => now,
    fetch: async (url) => {
      urls.push(url);
      const r = script.shift();
      if (!r) throw new Error('script exhausted');
      return r;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { c, sleeps, urls };
}

describe('GitHubClient classification', () => {
  it('403 secondary without retry-after backs off ≥60s and is not auth', async () => {
    const { c, sleeps } = client([res(403, { message: 'You have exceeded a secondary rate limit' }), res(200, { ok: 1 })]);
    await expect(c.rest('/x')).resolves.toMatchObject({ data: { ok: 1 } });
    expect(sleeps[0]).toBeGreaterThanOrEqual(60_000);
  });
  it('429 retry-after 120 waits exactly 120s', async () => {
    const { c, sleeps } = client([res(429, {}, { 'Retry-After': '120' }), res(200, {})]);
    await c.rest('/x');
    expect(sleeps).toEqual([120_000]);
  });
  it('secondary gives up after 3 retries', async () => {
    const s = () => res(403, { message: 'secondary rate limit' });
    const { c } = client([s(), s(), s(), s()]);
    await expect(c.rest('/x')).rejects.toThrow(/secondary/);
  });
  it('primary limit waits until reset', async () => {
    const now = 1_000_000_000_000;
    const { c, sleeps } = client([res(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 30) }), res(200, {})], now);
    await c.rest('/x');
    expect(sleeps).toEqual([30_000]);
  });
  it('SSO 403 → OrgBlockedError with url', async () => {
    const { c } = client([res(403, {}, { 'X-GitHub-SSO': 'required; url=https://github.com/orgs/acme/sso?x=1' })]);
    await expect(c.rest('/x')).rejects.toMatchObject({ url: 'https://github.com/orgs/acme/sso?x=1' });
  });
  it('partial-results succeeds', async () => {
    const { c } = client([res(200, [], { 'x-github-sso': 'partial-results; organizations=21955855,acme' })]);
    await expect(c.rest('/user/repos')).resolves.toMatchObject({ data: [] });
  });
  it('plain 403 and 401 → SourceAuthError', async () => {
    await expect(client([res(403, { message: 'Resource not accessible' })]).c.rest('/x')).rejects.toMatchObject({ code: 'auth' });
    await expect(client([res(401, { message: 'Bad credentials' })]).c.rest('/x')).rejects.toMatchObject({ code: 'auth' });
  });
  it('404 → NotFoundError; 409 → empty list', async () => {
    await expect(client([res(404)]).c.rest('/x')).rejects.toBeInstanceOf(NotFoundError);
    await expect(client([res(409, { message: 'Git Repository is empty.' })]).c.rest('/x')).resolves.toMatchObject({ data: [] });
  });
  it('5xx retries 4 times then throws', async () => {
    const { c, sleeps } = client([res(502), res(502), res(502), res(502), res(502)]);
    await expect(c.rest('/x')).rejects.toThrow(/502/);
    expect(sleeps).toEqual([2000, 4000, 8000, 16000]);
  });
  it('GraphQL 200 RATE_LIMITED (primary) waits until reset, not 60s', async () => {
    const now = 1_000_000_000_000;
    const { c, sleeps } = client(
      [
        res(200, { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 5) }),
        res(200, { data: { viewer: { login: 'a' } } }),
      ],
      now,
    );
    await expect(c.graphql('{viewer{login}}')).resolves.toEqual({ viewer: { login: 'a' } });
    expect(sleeps).toEqual([5000]);
  });
  it('GraphQL secondary message backs off ≥60s', async () => {
    const { c, sleeps } = client([res(200, { errors: [{ message: 'You have exceeded a secondary rate limit.' }] }), res(200, { data: { ok: true } })]);
    await c.graphql('{x}');
    expect(sleeps[0]).toBeGreaterThanOrEqual(60_000);
  });
  it('GraphQL INSUFFICIENT_SCOPES → InsufficientScopesError', async () => {
    const { c } = client([res(200, { data: null, errors: [{ type: 'INSUFFICIENT_SCOPES', message: 'needs read:project' }] })]);
    await expect(c.graphql('{x}')).rejects.toBeInstanceOf(InsufficientScopesError);
  });
});

describe('GitHubClient GraphQL errors', () => {
  it('SAML-forbidden with no data → OrgBlockedError', async () => {
    const { c } = client([res(200, { data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement.' }] })]);
    await expect(c.graphql('{x}')).rejects.toBeInstanceOf(OrgBlockedError);
  });
  it('partial data (one null alias) is returned, not thrown', async () => {
    const { c } = client([res(200, { data: { r0: { ok: 1 }, r1: null }, errors: [{ type: 'NOT_FOUND', path: ['r1'], message: 'no repo' }] })]);
    await expect(c.graphql('{x}')).resolves.toEqual({ r0: { ok: 1 }, r1: null });
  });
  it('NOT_FOUND with no data → NotFoundError', async () => {
    const { c } = client([res(200, { data: null, errors: [{ type: 'NOT_FOUND', message: 'gone' }] })]);
    await expect(c.graphql('{x}')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('GitHubClient paging', () => {
  it('restPages follows Link rel=next', async () => {
    const { c, urls } = client([
      res(200, [1, 2], { link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=2>; rel="last"' }),
      res(200, [3]),
    ]);
    const all: number[] = [];
    for await (const p of c.restPages<number>('/x')) all.push(...p.data);
    expect(all).toEqual([1, 2, 3]);
    expect(urls[0]).toContain('per_page=100');
  });
  it('compareCommits pages the envelope', async () => {
    const commit = (i: number) => ({ sha: `s${i}`, author: null, commit: { message: 'm', author: { name: 'n', email: 'e', date: 'd' } } });
    const { c, urls } = client([
      res(200, { status: 'ahead', total_commits: 103, commits: Array.from({ length: 100 }, (_, i) => commit(i)) }),
      res(200, { status: 'ahead', total_commits: 103, commits: [commit(100), commit(101), commit(102)] }),
    ]);
    const all: string[] = [];
    for await (const p of c.compareCommits('o/r', 'a', 'b')) all.push(...p.map((x) => x.sha));
    expect(all).toHaveLength(103);
    expect(urls[1]).toContain('per_page=100');
    expect(urls[1]).toContain('page=2');
  });
});
