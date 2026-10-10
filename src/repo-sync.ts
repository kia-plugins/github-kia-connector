import type { DocumentInput } from '@kiagent/connector-sdk';
import { NotFoundError, OrgBlockedError, type GhCommit, type GitHubClient } from './client';
import { dayKeyOf, mergeLedger } from './day';
import { itemEntries, renderItem, type FullItem } from './item';
import { actorOf, coAuthors, type Actorish } from './people';
import type { InvRepo } from './scope';
import { dayKey } from './time';
import type { Entry, RepoState } from './types';

const FIVE_MIN = 5 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

/* ---------------------------------------------------------------- ledgers */

type DayType = 'github.day' | 'github.project_day';

/** Per-pass day-ledger cache: each day doc is loaded once, merged in memory
 *  by every stage that touches it, and rendered when its leaf is flushed. */
export interface Ledgers {
  put(key: string, type: DayType, entries: Entry[]): void;
  /** Touched keys whose externalId starts with `prefix`; removed from the
   *  touched set. Returns [key, merged ledger]. */
  take(prefix: string): Promise<[string, Entry[]][]>;
}

export function makeLedgers(load: (externalId: string, type: DayType) => Promise<Entry[] | null>): Ledgers {
  const pending = new Map<string, { type: DayType; entries: Entry[] }>();
  return {
    put(key, type, entries) {
      if (!entries.length) return;
      const p = pending.get(key) ?? { type, entries: [] };
      p.entries = mergeLedger(p.entries, entries);
      pending.set(key, p);
    },
    async take(prefix) {
      const out: [string, Entry[]][] = [];
      for (const [key, p] of [...pending]) {
        if (!key.startsWith(prefix)) continue;
        pending.delete(key);
        const prior = await load(key, p.type);
        out.push([key, mergeLedger(prior, p.entries)]);
      }
      return out;
    },
  };
}

const putDay = (led: Ledgers, repo: string, tz: string, e: Entry) => led.put(dayKeyOf('repo', repo, dayKey(e.at, tz)), 'github.day', [e]);

/* ---------------------------------------------------------------- commits */

interface RefNode { name: string; target: { oid?: string; committedDate?: string } | null }

async function listBranches(c: GitHubClient, repo: string): Promise<RefNode[]> {
  const [owner, name] = repo.split('/');
  const out: RefNode[] = [];
  let after: string | null = null;
  for (;;) {
    const d: { repository: { refs: { nodes: RefNode[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } | null } = await c.graphql(
      `query($o:String!,$n:String!,$c:String){ repository(owner:$o,name:$n){ refs(refPrefix:"refs/heads/", first:100, after:$c){ nodes{ name target{ ... on Commit{ oid committedDate } } } pageInfo{ hasNextPage endCursor } } } }`,
      { o: owner, n: name, c: after },
    );
    if (!d.repository) throw new NotFoundError(`repo ${repo}`);
    out.push(...d.repository.refs.nodes);
    if (!d.repository.refs.pageInfo.hasNextPage) return out;
    after = d.repository.refs.pageInfo.endCursor;
  }
}

function commitEntry(cm: GhCommit, branch: string): Entry {
  const [first, ...rest] = cm.commit.message.split('\n');
  const co = coAuthors(cm.commit.message);
  const detail = rest.join('\n').replace(/^co-authored-by:.*$/gim, '').trim();
  return {
    id: cm.sha,
    at: cm.commit.author.date,
    actor: actorOf({ login: cm.author?.login, name: cm.commit.author.name, email: cm.commit.author.email }),
    emails: [cm.commit.author.email, ...co.map((x) => x.email)].filter(Boolean),
    text: `commit \`${cm.sha.slice(0, 7)}\` on \`${branch}\` — ${first}${co.length ? ` (co-authored with ${co.map((x) => x.name).join(', ')})` : ''}`,
    ...(detail ? { detail } : {}),
  };
}

/** Push-gated commits stage for one repo (spec §6.2 step 2). Mutates `st`. */
export async function syncCommits(c: GitHubClient, repo: InvRepo, st: RepoState, tz: string, led: Ledgers): Promise<void> {
  const branches = await listBranches(c, repo.full);
  const head = (b: RefNode) => b.target?.oid;
  const def = branches.find((b) => b.name === repo.defaultBranch);
  const changed = branches
    .filter((b) => head(b) && head(b) !== st.branchHeads[b.name] && (b.target?.committedDate ?? '') >= st.horizon)
    .sort((a, b) => (a.name === repo.defaultBranch ? -1 : b.name === repo.defaultBranch ? 1 : 0));
  const seen = new Set<string>();
  const take = (cm: GhCommit, branch: string) => {
    if (seen.has(cm.sha) || !cm.commit?.author?.date || cm.commit.author.date < st.horizon) return;
    seen.add(cm.sha);
    putDay(led, repo.full, tz, commitEntry(cm, branch));
  };
  for (const b of changed) {
    const old = st.branchHeads[b.name];
    const base = old ?? (b.name !== repo.defaultBranch && def ? head(def) : undefined);
    let viaCompare = false;
    if (base) {
      try {
        for await (const page of c.compareCommits(repo.full, base, head(b)!)) for (const cm of page) take(cm, b.name);
        viaCompare = true;
      } catch (e) {
        if (!(e instanceof NotFoundError) && !/\b422\b/.test(String(e))) throw e;
      }
    }
    if (!viaCompare) {
      for await (const p of c.restPages<GhCommit>(`/repos/${repo.full}/commits`, { sha: b.name, since: st.horizon })) for (const cm of p.data) take(cm, b.name);
    }
  }
  const heads: Record<string, string> = {};
  for (const b of branches) if (head(b)) heads[b.name] = head(b)!;
  st.branchHeads = heads;
  st.pushedAt = repo.pushedAt;
}

/* --------------------------------------------------------------- releases */

interface RelNode { databaseId: number; name: string | null; tagName: string; createdAt: string; publishedAt: string | null; isDraft: boolean; url: string; author: { login: string; name: string | null } | null }

async function releasesChunk(c: GitHubClient, repos: InvRepo[]): Promise<Record<string, RelNode[]>> {
  const fields = 'releases(first:100, orderBy:{field:CREATED_AT,direction:DESC}){ nodes{ databaseId name tagName createdAt publishedAt isDraft url author{ login name } } }';
  const q = `query{ ${repos.map((r, i) => `r${i}: repository(owner:${JSON.stringify(r.owner)}, name:${JSON.stringify(r.full.slice(r.owner.length + 1))}){ ${fields} }`).join(' ')} }`;
  const d = await c.graphql<Record<string, { releases: { nodes: RelNode[] } } | null>>(q);
  const out: Record<string, RelNode[]> = {};
  repos.forEach((r, i) => (out[r.full] = d?.[`r${i}`]?.releases.nodes ?? []));
  return out;
}

/** Releases are polled (a draft→publish moves no push). Window-replayed. */
export async function syncReleases(c: GitHubClient, repos: InvRepo[], states: Record<string, RepoState>, tz: string, led: Ledgers, log?: (m: string) => void): Promise<void> {
  for (let i = 0; i < repos.length; i += 50) {
    const chunk = repos.slice(i, i + 50);
    let byRepo: Record<string, RelNode[]> = {};
    try {
      byRepo = await releasesChunk(c, chunk);
    } catch (e) {
      if (!(e instanceof OrgBlockedError || e instanceof NotFoundError || /graphql/.test(String(e)))) throw e;
      for (const r of chunk) {
        try {
          Object.assign(byRepo, await releasesChunk(c, [r]));
        } catch (e2) {
          if (!(e2 instanceof OrgBlockedError || e2 instanceof NotFoundError || /graphql/.test(String(e2)))) throw e2;
          log?.(`github: releases skipped for ${r.full}: ${String(e2)}`);
        }
      }
    }
    for (const r of chunk) {
      const st = states[r.full];
      for (const n of byRepo[r.full] ?? []) {
        if (n.isDraft || !n.publishedAt || n.publishedAt < st.horizon) continue;
        putDay(led, r.full, tz, {
          id: `release:${n.databaseId}`,
          at: n.publishedAt,
          actor: actorOf(n.author),
          text: `released [${n.name || n.tagName}](${n.url})`,
        });
      }
    }
  }
}

/* ------------------------------------------------------------------ items */

export interface SearchGroup { query: string; repos: string[] }

const ghTime = (isoStr: string) => isoStr.replace(/\.\d{3}Z$/, 'Z').replace(/Z$/, '+00:00');

/** Owner-wide queries where an acct/org root covers the repos; repo:
 *  qualifiers in batches of 5 for leaf-ticked and shared repos. */
export function searchGroups(covered: InvRepo[], roots: { id: string }[], states: Record<string, RepoState>): SearchGroup[] {
  const ownerRoots = new Set(roots.map((r) => r.id).filter((id) => /^(acct|org):/.test(id)).map((id) => id.replace(/^(acct|org):/, '')));
  const since = (repos: string[]) => ghTime(iso(Math.min(...repos.map((r) => Date.parse(states[r].itemsSyncedTo))) - FIVE_MIN));
  const groups: SearchGroup[] = [];
  const byOwner = new Map<string, InvRepo[]>();
  const loose: InvRepo[] = [];
  for (const r of covered) {
    if (ownerRoots.has(r.owner)) byOwner.set(r.owner, [...(byOwner.get(r.owner) ?? []), r]);
    else loose.push(r);
  }
  for (const [owner, rs] of byOwner) {
    const repos = rs.map((r) => r.full);
    groups.push({ query: `${rs[0].ownerType === 'Organization' ? 'org' : 'user'}:${owner} updated:>=${since(repos)}`, repos });
  }
  for (let i = 0; i < loose.length; i += 5) {
    const repos = loose.slice(i, i + 5).map((r) => r.full);
    groups.push({ query: `${repos.map((r) => `repo:${r}`).join(' ')} updated:>=${since(repos)}`, repos });
  }
  return groups;
}

interface SearchHit { number: number; updated_at: string; repository_url: string; pull_request?: unknown }
type GhUser = { login: string; name?: string | null } | null;
const u = (x: GhUser): Actorish => ({ login: x?.login ?? null });

async function all<T>(c: GitHubClient, path: string): Promise<T[]> {
  const out: T[] = [];
  for await (const p of c.restPages<T>(path)) out.push(...p.data);
  return out;
}

async function fetchItem(c: GitHubClient, repo: string, n: number, isPr: boolean): Promise<FullItem> {
  const { data: is } = await c.rest<any>(`/repos/${repo}/issues/${n}`);
  const comments = await all<any>(c, `/repos/${repo}/issues/${n}/comments`);
  const item: FullItem = {
    repo,
    number: n,
    isPr,
    title: is.title,
    url: is.html_url,
    state: is.state === 'open' ? 'open' : 'closed',
    author: u(is.user),
    createdAt: is.created_at,
    updatedAt: is.updated_at,
    closedAt: is.closed_at,
    closedBy: is.closed_by ? u(is.closed_by) : null,
    body: is.body ?? '',
    labels: (is.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)),
    assignees: (is.assignees ?? []).map(u),
    reviewers: [],
    comments: comments.map((x) => ({ id: x.id, at: x.created_at, author: u(x.user), body: x.body ?? '' })),
    reviews: [],
  };
  if (isPr) {
    const { data: pr } = await c.rest<any>(`/repos/${repo}/pulls/${n}`);
    const reviews = await all<any>(c, `/repos/${repo}/pulls/${n}/reviews`);
    const rc = await all<any>(c, `/repos/${repo}/pulls/${n}/comments`);
    item.mergedAt = pr.merged_at;
    item.mergedBy = pr.merged_by ? u(pr.merged_by) : null;
    item.state = pr.merged_at ? 'merged' : pr.draft && pr.state === 'open' ? 'draft' : item.state;
    item.base = pr.base?.ref;
    item.head = pr.head?.ref;
    item.reviewers = (pr.requested_reviewers ?? []).map(u);
    item.reviews = reviews.filter((r) => r.submitted_at && r.state !== 'PENDING').map((r) => ({ id: r.id, at: r.submitted_at, author: u(r.user), state: r.state, body: r.body ?? '' }));
    item.comments.push(...rc.map((x) => ({ id: x.id, at: x.created_at, author: u(x.user), body: x.body ?? '', path: x.path, line: x.line ?? x.original_line ?? null })));
  }
  return item;
}

/** Touched issues/PRs via search, then a FULL per-item refetch. Returns item
 *  docs; writes day entries; advances itemsSyncedTo only on success. */
export async function syncItems(c: GitHubClient, group: SearchGroup, states: Record<string, RepoState>, tz: string, led: Ledgers, passStart: string, log?: (m: string) => void): Promise<DocumentInput[]> {
  const docs: DocumentInput[] = [];
  const done = new Set<string>();
  const failed = new Set<string>();
  const inGroup = new Set(group.repos);
  let query = group.query;
  for (;;) {
    let pages = 0;
    let last: string | null = null;
    for await (const p of c.restPages<SearchHit>('/search/issues', { q: query, sort: 'updated', order: 'asc' })) {
      pages++;
      for (const h of p.data) {
        last = h.updated_at;
        const repo = h.repository_url.replace(/^.*\/repos\//, '');
        const st = states[repo];
        const key = `${repo}#${h.number}`;
        if (!inGroup.has(repo) || !st || done.has(key)) continue;
        if (Date.parse(h.updated_at) < Date.parse(st.itemsSyncedTo) - FIVE_MIN) continue;
        done.add(key);
        let item: FullItem;
        try {
          item = await fetchItem(c, repo, h.number, !!h.pull_request);
        } catch (e) {
          if (e instanceof NotFoundError || e instanceof OrgBlockedError) {
            // Keep this repo's watermark so the item is retried next pass.
            failed.add(repo);
            log?.(`github: skipped ${key}: ${String(e)}`);
            continue;
          }
          throw e;
        }
        docs.push(renderItem(item));
        for (const e of itemEntries(item)) if (e.at >= st.horizon) putDay(led, repo, tz, e);
      }
    }
    // Search caps at 1000 results (10 pages): slide the lower bound forward.
    if (pages < 10 || !last) break;
    query = query.replace(/updated:>=\S+/, `updated:>=${ghTime(last)}`);
  }
  for (const r of group.repos) if (!failed.has(r)) states[r].itemsSyncedTo = passStart;
  return docs;
}
