import type { DocumentInput } from '@kiagent/connector-sdk';
import { fakeAuthChannel, fakeFolderSelectionChannel, fakeSession, jsonRes } from '@kiagent/connector-sdk/testing';
import { createGitHubSource, snapBackfill } from '../source';
import type { Config, Cursor } from '../types';
import { commit, fakeGitHub, type Handler } from './helpers/fake-github';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const Y = '2026-10-08T10:00:00Z';

/** In-memory corpus standing in for core's store (byExternalId + search). */
function corpus() {
  const docs = new Map<string, DocumentInput & { archived?: boolean }>();
  const k = (id: string, t: string) => `${t}|${id}`;
  return {
    docs,
    apply(items: unknown[]) {
      for (const it of items) for (const d of ([] as DocumentInput[]).concat(it as DocumentInput)) docs.set(k(d.externalId, d.type), { ...d, archived: false });
    },
    archive(stamps: string[]) {
      for (const d of docs.values()) if (d.scopeRootId && stamps.includes(d.scopeRootId)) d.archived = true;
    },
    query: {
      byExternalId: async (_a: string, id: string, t: string) => (docs.get(k(id, t)) as never) ?? null,
      search: async (q: { type?: string; includeArchived?: boolean; limit?: number; offset?: number }) =>
        [...docs.values()].filter((d) => (!q.type || d.type === q.type) && (q.includeArchived || !d.archived)).slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 50)) as never,
    },
  };
}

interface World {
  repos: { full_name: string; owner: { login: string; type: string }; pushed_at: string; default_branch: string; archived: boolean }[];
  routes: [RegExp, Handler][];
}
const world = (): World => ({
  repos: [
    { full_name: 'acme/api', owner: { login: 'acme', type: 'Organization' }, pushed_at: Y, default_branch: 'main', archived: false },
    { full_name: 'acme/web', owner: { login: 'acme', type: 'Organization' }, pushed_at: Y, default_branch: 'main', archived: false },
  ],
  routes: [],
});

function boardRoutes(status: string, statusAt: string, boardUpdated = Y): [RegExp, Handler][] {
  return [
    [/organization\(login/, () => ({ data: { organization: { projectsV2: { nodes: [{ id: 'PB', number: 3, title: 'Roadmap', url: 'https://github.com/orgs/acme/projects/3', createdAt: '2025-01-01T00:00:00Z', shortDescription: null, updatedAt: boardUpdated, closed: false }] } } } })],
    [/node\(id/, () => ({
      data: {
        node: {
          fields: { nodes: [{ name: 'Status', options: [{ name: 'Todo' }, { name: 'Done' }] }] },
          items: {
            nodes: [{
              id: 'I1', createdAt: '2024-01-01T00:00:00Z', creator: { login: 'alice' }, type: 'ISSUE',
              content: { id: 'C1', number: 1, title: 'Fix', url: 'https://github.com/acme/api/issues/1', repository: { nameWithOwner: 'acme/api' }, assignees: { nodes: [] } },
              fieldValues: { nodes: [{ __typename: 'ProjectV2ItemFieldSingleSelectValue', name: status, updatedAt: statusAt, creator: { login: 'bob' }, field: { name: 'Status' } }] },
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    })],
  ];
}

function setup(w: World, extra: [RegExp, Handler][] = []) {
  const gh = fakeGitHub([
    ...extra,
    ...w.routes,
    [/GET \/user$/, () => jsonRes(200, { login: 'me', id: 42 }, { 'x-oauth-scopes': 'repo, read:org, read:project' })],
    [/GET \/user\/repos/, () => w.repos],
    [/refs\(/, (_u, b) => ({ data: { repository: { refs: { nodes: [{ name: 'main', target: { oid: `h-${b!.variables!.n}`, committedDate: Y } }], pageInfo: { hasNextPage: false } } } } })],
    [/GET \/repos\/acme\/api\/commits/, () => [commit('sha1', Y, 'feat: api thing')]],
    [/GET \/repos\/acme\/web\/commits/, () => [commit('sha2', Y, 'fix: web thing', 'bob')]],
    [/releases\(/, () => ({ data: {} })],
    [/search\/issues/, () => ({ items: [] })],
    [/organization\(login/, () => ({ data: { organization: { projectsV2: { nodes: [] } } } })],
  ]);
  const store = corpus();
  const src = createGitHubSource({ self: { id: 'github', dataDir: '/tmp' }, log: () => {}, net: { fetch: gh.fetch as never }, query: store.query as never } as never, { now: () => NOW, tz: 'UTC', sleep: async () => {} });
  return { gh, store, src };
}

const cfg = (roots: string[]): Config => ({ login: 'me', userId: 42, folderRoots: roots.map((id) => ({ id, name: id })), backfillDays: 30 });
async function drain(src: ReturnType<typeof setup>['src'], store: ReturnType<typeof corpus>, config: Config, cursor: Cursor | null) {
  const session = fakeSession({ account: { id: 'acc', config, cursor }, credentials: { accessToken: 'tok' } });
  const batches = [];
  for await (const b of src.pull(session, cursor)) {
    batches.push(b);
    store.apply(b.items);
  }
  return { batches, cursor: batches.at(-1)!.cursor, logs: session.logs };
}

describe('descriptor + connect', () => {
  it('descriptor', () => {
    expect(setup(world()).src.descriptor).toMatchObject({ id: 'github', auth: 'oauth', multiAccount: true, folderScope: true, cadence: { every: '15m' } });
  });
  it('empty token → oauth with the 5 scopes; config from picker', async () => {
    const { src } = setup(world());
    const scopes: string[][] = [];
    const auth = fakeAuthChannel({
      prompt: async () => ({ password: '', backfillDays: '45' }),
      oauth: async (s) => (scopes.push(s), { accessToken: 'gho_x' }),
      pickFolders: async () => [{ id: 'org:acme', name: 'acme', hasChildren: true }],
    });
    const r = await src.connect(auth);
    expect(scopes[0]).toEqual(['repo', 'read:org', 'read:user', 'user:email', 'read:project']);
    expect(r).toEqual({ identifier: 'me', config: { login: 'me', userId: 42, folderRoots: [{ id: 'org:acme', name: 'acme' }], backfillDays: 30 } });
  });
  it('ghp_ token skips oauth; public_repo-only token is rejected; empty picker throws', async () => {
    const ok = setup(world());
    await expect(ok.src.connect(fakeAuthChannel({ prompt: async () => ({ password: 'ghp_abc' }), pickFolders: async () => [] }))).rejects.toThrow(/pick at least one/);
    const bad = setup(world(), [[/GET \/user$/, () => jsonRes(200, { login: 'me', id: 42 }, { 'x-oauth-scopes': 'public_repo, read:org' })]]);
    await expect(bad.src.connect(fakeAuthChannel({ prompt: async () => ({ password: 'ghp_abc' }) }))).rejects.toThrow(/repo/);
  });
  it('fine-grained token (no scopes header) passes', async () => {
    const { src } = setup(world(), [[/GET \/user$/, () => ({ login: 'me', id: 42 })]]);
    const r = await src.connect(fakeAuthChannel({ prompt: async () => ({ password: 'github_pat_x' }), pickFolders: async () => [{ id: 'repo:acme/api', name: 'acme/api', hasChildren: false }] }));
    expect(r.identifier).toBe('me');
  });
  it('snapBackfill', () => {
    expect([snapBackfill('45'), snapBackfill('400'), snapBackfill(''), snapBackfill('7')]).toEqual([30, 365, 30, 7]);
  });
  it('reauthenticate as another user throws', async () => {
    const { src } = setup(world(), [[/GET \/user$/, () => ({ login: 'other', id: 7 })]]);
    await expect(src.reauthenticate!({ id: 'acc', identifier: 'me', config: cfg(['org:acme']) } as never, fakeAuthChannel({ prompt: async () => ({ password: 'ghp_x' }) }))).rejects.toThrow(/signed in as other/);
  });
});

describe('pull', () => {
  it('end-to-end: register-first, day docs, one aggregate board item with the snapshot LAST, live', async () => {
    const { src, store } = setup(world(), boardRoutes('Done', Y));
    const { batches, cursor } = await drain(src, store, cfg(['org:acme']), null);
    expect(batches[0].items).toEqual([]);
    expect(Object.keys(batches[0].cursor.repos).sort()).toEqual(['acme/api', 'acme/web']);
    const day = store.docs.get('github.day|acme/api:2026-10-08')!;
    expect(day.scopeRootId).toBe('repo:acme/api');
    expect(day.markdown).toContain('feat: api thing');
    const agg = batches.find((b) => Array.isArray(b.items[0]))!.items[0] as DocumentInput[];
    expect(agg.at(-1)!.type).toBe('github.project');
    expect((agg.at(-1)!.metadata.snapshot as { items: object }).items).toHaveProperty('I1');
    expect(agg.some((d) => d.externalId === 'acme/project/3:2026-10-08')).toBe(true);
    expect(batches.at(-1)!.phase).toBe('live');
    expect(cursor.phase).toBe('live');
    expect(cursor.projects['acme/3'].updatedAt).toBe(Y);
  });

  it('second pass with nothing changed makes no GitHub item/commit calls', async () => {
    const { src, store, gh } = setup(world(), boardRoutes('Done', Y));
    const first = await drain(src, store, cfg(['org:acme']), null);
    gh.calls.length = 0;
    await drain(src, store, cfg(['org:acme']), first.cursor);
    expect(gh.calls.filter((c) => /commits|refs\(|node\(id/.test(c))).toEqual([]);
  });

  it('INSUFFICIENT_SCOPES skips boards quietly, repos still sync, flag clears once scopes return', async () => {
    const w = world();
    const noScope: [RegExp, Handler][] = [[/organization\(login/, () => ({ data: null, errors: [{ type: 'INSUFFICIENT_SCOPES', message: 'read:project' }] })]];
    const a = setup(w, noScope);
    const r1 = await drain(a.src, a.store, cfg(['org:acme']), null);
    expect(r1.cursor.projectsUnavailable).toBe(true);
    expect(a.store.docs.has('github.day|acme/api:2026-10-08')).toBe(true);
    const b = setup(w, boardRoutes('Done', Y));
    const r2 = await drain(b.src, b.store, cfg(['org:acme']), r1.cursor);
    expect(r2.cursor.projectsUnavailable).toBeUndefined();
  });

  it('SSO-blocked org does not stop a healthy one; its state is untouched', async () => {
    const w = world();
    w.repos.push({ full_name: 'blk/x', owner: { login: 'blk', type: 'Organization' }, pushed_at: Y, default_branch: 'main', archived: false });
    const { src, store } = setup(w, [
      [/refs\(/, (_u, b) => (b!.variables!.o === 'blk' ? jsonRes(403, {}, { 'x-github-sso': 'required; url=https://github.com/orgs/blk/sso' }) : { data: { repository: { refs: { nodes: [{ name: 'main', target: { oid: 'h', committedDate: Y } }], pageInfo: { hasNextPage: false } } } } })],
    ]);
    const { cursor } = await drain(src, store, cfg(['org:acme', 'org:blk']), null);
    expect(cursor.orgsBlocked).toEqual({ blk: { url: 'https://github.com/orgs/blk/sso' } });
    expect(cursor.repos['blk/x']).toMatchObject({ pushedAt: '', branchHeads: {} });
    expect(cursor.repos['acme/api'].pushedAt).toBe(Y);
    expect(store.docs.has('github.day|acme/api:2026-10-08')).toBe(true);
  });

  it('crash after day docs but before the snapshot doc: replay is idempotent', async () => {
    const w = world();
    const s1 = setup(w, boardRoutes('Todo', '2026-10-07T09:00:00Z', '2026-10-07T09:00:00Z'));
    const r1 = await drain(s1.src, s1.store, cfg(['org:acme']), null);
    // Board moves Todo → Done; simulate the crash: commit everything but the github.project doc, keep the old cursor.
    const s2 = setup(w, boardRoutes('Done', Y));
    s2.store.docs = s1.store.docs as never;
    const session = fakeSession({ account: { id: 'acc', config: cfg(['org:acme']), cursor: r1.cursor }, credentials: { accessToken: 't' } });
    for await (const b of s2.src.pull(session, r1.cursor)) {
      for (const it of b.items) {
        const arr = ([] as DocumentInput[]).concat(it as DocumentInput);
        s1.store.apply(arr.filter((d) => d.type !== 'github.project'));
      }
      if (b.items.some((it) => Array.isArray(it))) break; // crash
    }
    const r3 = await drain(s2.src, s1.store, cfg(['org:acme']), r1.cursor);
    const day = s1.store.docs.get('github.project_day|acme/project/3:2026-10-08')!;
    const moves = (day.metadata.ledger as { id: string }[]).filter((e) => e.id.startsWith('move:'));
    expect(moves.map((m) => m.id)).toEqual([`move:I1:Status:Done@${Y}`]);
    expect(r3.cursor.projects['acme/3'].updatedAt).toBe(Y);
  });
});

describe('manageFolders', () => {
  it('untick org, tick one repo: archives siblings and boards, keeps the ticked repo; a repo appearing while the picker is open is archived too', async () => {
    const w = world();
    const { src, store } = setup(w, boardRoutes('Done', Y));
    const { cursor } = await drain(src, store, cfg(['org:acme']), null);
    const channel = fakeFolderSelectionChannel({
      pickFolders: async () => {
        w.repos.push({ full_name: 'acme/new', owner: { login: 'acme', type: 'Organization' }, pushed_at: Y, default_branch: 'main', archived: false });
        return [{ id: 'repo:acme/api', name: 'acme/api', hasChildren: false }];
      },
    });
    const session = fakeSession({ account: { id: 'acc', config: cfg(['org:acme']), cursor }, credentials: { accessToken: 't' } });
    const upd = await src.manageFolders!(session, channel);
    expect(upd.archiveScopeRootIds.sort()).toEqual(['project:acme/3', 'repo:acme/new', 'repo:acme/web']);
    expect(Object.keys(upd.cursor!.repos)).toEqual(['acme/api']);
    expect(upd.cursor!.projects).toEqual({});
    expect(upd.config.folderRoots).toEqual([{ id: 'repo:acme/api', name: 'acme/api' }]);
    expect(channel.specs[0].selected).toEqual([{ id: 'org:acme', name: 'org:acme', hasChildren: true }]);
  });

  it('re-tick a board within retention: archived day docs come back via restore', async () => {
    const w = world();
    const { src, store } = setup(w, boardRoutes('Done', Y));
    const r1 = await drain(src, store, cfg(['org:acme']), null);
    store.archive(['project:acme/3']);
    const cur = structuredClone(r1.cursor);
    delete cur.projects['acme/3'];
    const r2 = await drain(src, store, cfg(['org:acme']), cur);
    const agg = r2.batches.find((b) => Array.isArray(b.items[0]))!.items[0] as DocumentInput[];
    expect(agg.map((d) => d.externalId)).toContain('acme/project/3:2026-10-08');
    expect(store.docs.get('github.project_day|acme/project/3:2026-10-08')!.archived).toBe(false);
  });
});
