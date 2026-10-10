import { jsonRes } from '@kiagent/connector-sdk/testing';
import { makeLedgers, searchGroups, syncCommits, syncItems, syncReleases } from '../repo-sync';
import type { InvRepo } from '../scope';
import type { Entry, RepoState } from '../types';
import { commit, fakeGitHub } from './helpers/fake-github';

const tz = 'UTC';
const repo: InvRepo = { full: 'acme/api', owner: 'acme', ownerType: 'Organization', pushedAt: '2026-10-08T12:00:00Z', defaultBranch: 'main', archived: false };
const state = (over: Partial<RepoState> = {}): RepoState => ({ ownerType: 'Organization', horizon: '2026-10-01T00:00:00Z', pushedAt: '', branchHeads: {}, itemsSyncedTo: '2026-10-01T00:00:00Z', ...over });
const refs = (nodes: { name: string; oid: string; date?: string }[]) => ({
  data: { repository: { refs: { nodes: nodes.map((n) => ({ name: n.name, target: { oid: n.oid, committedDate: n.date ?? '2026-10-08T10:00:00Z' } })), pageInfo: { hasNextPage: false, endCursor: null } } } },
});
const noLedgers = () => makeLedgers(async () => null);
const take = async (led: ReturnType<typeof makeLedgers>, prefix = '') => Object.fromEntries(await led.take(prefix)) as Record<string, Entry[]>;

describe('syncCommits', () => {
  it('new default branch: list scan; author-date predicate drops old commits; co-authors', async () => {
    const { client, calls } = fakeGitHub([
      [/refs\(/, () => refs([{ name: 'main', oid: 'h1' }])],
      [/GET \/repos\/acme\/api\/commits/, () => [commit('c2', '2026-10-08T09:00:00Z', 'fix\n\nbody\nCo-authored-by: Bob <bob@x.io>'), commit('old', '2026-09-01T00:00:00Z')]],
    ]);
    const st = state();
    const led = noLedgers();
    await syncCommits(client, repo, st, tz, led);
    const days = await take(led);
    expect(Object.keys(days)).toEqual(['acme/api:2026-10-08']);
    const [e] = days['acme/api:2026-10-08'];
    expect(e.id).toBe('c2');
    expect(e.emails).toEqual(['alice@x.io', 'bob@x.io']);
    expect(e.detail).toBe('body');
    expect(st.branchHeads).toEqual({ main: 'h1' });
    expect(st.pushedAt).toBe(repo.pushedAt);
    expect(calls.find((c) => c.includes('/commits'))).toContain('since=2026-10-01');
  });
  it('known head: paged compare (merge brings older-sorted commits)', async () => {
    const { client } = fakeGitHub([
      [/refs\(/, () => refs([{ name: 'main', oid: 'h2' }])],
      [/compare\/h1\.\.\.h2/, () => ({ status: 'ahead', commits: [commit('m1', '2026-10-05T00:00:00Z'), commit('m2', '2026-10-08T00:00:00Z')] })],
    ]);
    const led = noLedgers();
    await syncCommits(client, repo, state({ branchHeads: { main: 'h1' } }), tz, led);
    const ids = Object.values(await take(led)).flat().map((e) => e.id).sort();
    expect(ids).toEqual(['m1', 'm2']);
  });
  it('new non-default branch compares against default head; diverged ingests its commits', async () => {
    const { client, calls } = fakeGitHub([
      [/refs\(/, () => refs([{ name: 'main', oid: 'h1' }, { name: 'feat', oid: 'f1' }])],
      [/compare\/h1\.\.\.f1/, () => ({ status: 'diverged', total_commits: 1, commits: [commit('f', '2026-10-08T00:00:00Z')] })],
    ]);
    const led = noLedgers();
    await syncCommits(client, repo, state({ branchHeads: { main: 'h1' } }), tz, led);
    expect(Object.values(await take(led)).flat().map((e) => e.id)).toEqual(['f']);
    expect(calls.some((c) => c.includes('/commits?'))).toBe(false);
  });
  it('compare 404 falls back to the list path; 409 empty repo yields nothing', async () => {
    const { client } = fakeGitHub([
      [/refs\(/, () => refs([{ name: 'main', oid: 'h2' }])],
      [/compare/, () => jsonRes(404, { message: 'Not Found' })],
      [/GET \/repos\/acme\/api\/commits/, () => jsonRes(409, { message: 'Git Repository is empty.' })],
    ]);
    const led = noLedgers();
    await expect(syncCommits(client, repo, state({ branchHeads: { main: 'gone' } }), tz, led)).resolves.toBeUndefined();
    expect(await take(led)).toEqual({});
  });
  it('branches older than the horizon are not fetched', async () => {
    const { client, calls } = fakeGitHub([[/refs\(/, () => refs([{ name: 'stale', oid: 's', date: '2025-01-01T00:00:00Z' }])]]);
    await syncCommits(client, { ...repo, defaultBranch: 'stale' }, state(), tz, noLedgers());
    expect(calls).toHaveLength(1);
  });
});

describe('syncReleases', () => {
  it('ingests a published release (no push needed), skips drafts and pre-horizon', async () => {
    const { client } = fakeGitHub([
      [/releases\(/, () => ({
        data: {
          r0: { releases: { nodes: [
            { databaseId: 1, name: 'v1', tagName: 'v1', createdAt: '2026-09-01T00:00:00Z', publishedAt: '2026-10-08T10:00:00Z', isDraft: false, url: 'u1', author: { login: 'alice', name: null } },
            { databaseId: 2, name: null, tagName: 'v2', createdAt: '2026-10-08T00:00:00Z', publishedAt: null, isDraft: true, url: 'u2', author: null },
            { databaseId: 3, name: 'v0', tagName: 'v0', createdAt: '2026-01-01T00:00:00Z', publishedAt: '2026-01-01T00:00:00Z', isDraft: false, url: 'u3', author: null },
          ] } },
        },
      })],
    ]);
    const led = noLedgers();
    await syncReleases(client, [repo], { 'acme/api': state() }, tz, led);
    expect(Object.values(await take(led)).flat().map((e) => e.id)).toEqual(['release:1']);
  });
});

describe('items', () => {
  const issue = (n: number, updated: string, extra: object = {}) => ({ number: n, title: `t${n}`, html_url: `https://github.com/acme/api/issues/${n}`, state: 'open', user: { login: 'bob' }, created_at: '2026-09-20T00:00:00Z', updated_at: updated, closed_at: null, body: 'b', labels: [], assignees: [], ...extra });
  const hit = (n: number, updated: string, pr = false) => ({ number: n, updated_at: updated, repository_url: 'https://api.github.com/repos/acme/api', ...(pr ? { pull_request: {} } : {}) });

  it('searchGroups: owner query for org roots, repo: batches for loose repos', () => {
    const states = { 'acme/api': state({ itemsSyncedTo: '2026-10-08T00:10:00.000Z' }), 'bob/tool': state() };
    const g = searchGroups([repo, { ...repo, full: 'bob/tool', owner: 'bob', ownerType: 'User' }], [{ id: 'org:acme' }, { id: 'shared' }], states);
    expect(g).toEqual([
      { query: 'org:acme updated:>=2026-10-08T00:05:00+00:00', repos: ['acme/api'] },
      { query: 'repo:bob/tool updated:>=2026-09-30T23:55:00+00:00', repos: ['bob/tool'] },
    ]);
  });

  it('comment-only activity yields the PR doc + day entries; closed by someone else is attributed to the closer', async () => {
    const { client } = fakeGitHub([
      [/search\/issues/, () => ({ total_count: 2, items: [hit(5, '2026-10-08T09:00:00Z', true), hit(6, '2026-10-08T10:00:00Z')] })],
      [/issues\/5\/comments/, () => [{ id: 50, created_at: '2026-10-08T09:00:00Z', user: { login: 'carol' }, body: 'hi' }, { id: 49, created_at: '2026-09-25T00:00:00Z', user: { login: 'dave' }, body: 'old' }]],
      [/issues\/5$/, () => issue(5, '2026-10-08T09:00:00Z')],
      [/pulls\/5\/reviews/, () => []],
      [/pulls\/5\/comments/, () => []],
      [/pulls\/5$/, () => ({ merged_at: null, merged_by: null, draft: false, state: 'open', base: { ref: 'main' }, head: { ref: 'x' }, requested_reviewers: [] })],
      [/issues\/6\/comments/, () => []],
      [/issues\/6$/, () => issue(6, '2026-10-08T10:00:00Z', { state: 'closed', closed_at: '2026-10-08T10:00:00Z', closed_by: { login: 'alice' } })],
    ]);
    const states = { 'acme/api': state({ itemsSyncedTo: '2026-10-08T08:00:00Z' }) };
    const led = noLedgers();
    const docs = await syncItems(client, { query: 'org:acme updated:>=x', repos: ['acme/api'] }, states, tz, led, '2026-10-08T12:00:00Z');
    expect(docs.map((d) => [d.externalId, d.type])).toEqual([['acme/api#5', 'github.pr'], ['acme/api#6', 'github.issue']]);
    expect(docs[0].markdown).toContain('old'); // full refetch keeps the pre-watermark comment
    const ledger = Object.values(await take(led)).flat();
    expect(ledger.find((e) => e.id === 'comment:50')?.actor).toBe('carol');
    expect(ledger.find((e) => e.id.includes('#6#closed'))?.actor).toBe('alice');
    expect(states['acme/api'].itemsSyncedTo).toBe('2026-10-08T12:00:00Z');
  });

  it('a hit older than the repo watermark costs zero item calls', async () => {
    const { client, calls } = fakeGitHub([[/search\/issues/, () => ({ items: [hit(7, '2026-10-01T00:00:00Z')] })]]);
    const docs = await syncItems(client, { query: 'q updated:>=x', repos: ['acme/api'] }, { 'acme/api': state({ itemsSyncedTo: '2026-10-08T00:00:00Z' }) }, tz, noLedgers(), '2026-10-08T12:00:00Z');
    expect(docs).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('SSO failure during a refetch keeps the watermark so recovery retries it', async () => {
    const { client } = fakeGitHub([
      [/search\/issues/, () => ({ items: [hit(8, '2026-10-08T09:00:00Z')] })],
      [/issues\/8/, () => jsonRes(403, {}, { 'x-github-sso': 'required; url=https://github.com/orgs/acme/sso' })],
    ]);
    const states = { 'acme/api': state({ itemsSyncedTo: '2026-10-08T08:00:00Z' }) };
    await syncItems(client, { query: 'q updated:>=x', repos: ['acme/api'] }, states, tz, noLedgers(), '2026-10-08T12:00:00Z');
    expect(states['acme/api'].itemsSyncedTo).toBe('2026-10-08T08:00:00Z');
  });
});

describe('ledgers', () => {
  it('two stages same day land in one doc ledger merged with the stored one', async () => {
    const led = makeLedgers(async (id) => (id === 'acme/api:2026-10-08' ? [{ id: 'prior', at: '2026-10-08T01:00:00Z', actor: 'x', text: 'p' }] : null));
    led.put('acme/api:2026-10-08', 'github.day', [{ id: 'sha', at: '2026-10-08T09:00:00Z', actor: 'a', text: 'c' }]);
    led.put('acme/api:2026-10-08', 'github.day', [{ id: 'comment:1', at: '2026-10-08T10:00:00Z', actor: 'b', text: 'm' }]);
    const out = await led.take('acme/api:');
    expect(out).toHaveLength(1);
    expect(out[0][1].map((e) => e.id)).toEqual(['prior', 'sha', 'comment:1']);
    expect(await led.take('acme/api:')).toEqual([]);
  });
});
