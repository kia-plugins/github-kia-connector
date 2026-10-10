import { IdentityMismatchError, SourceAuthError, type AuthChannel, type DocumentInput, type HostFor, type Source } from '@kiagent/connector-sdk';
import { GitHubClient, InsufficientScopesError, NotFoundError, OrgBlockedError } from './client';
import { renderDay, type DayKind } from './day';
import { diffBoard, renderBoard, restoreBoardDays, scanBoard, toSnapshot, type BoardSnapshot } from './project';
import { makeLedgers, searchGroups, syncCommits, syncItems, syncReleases } from './repo-sync';
import { archiveSet, boardLeaf, covers, loadBoards, loadInventory, pickerSpec, repoLeaf, type InvBoard, type InvRepo, type OwnerType } from './scope';
import { dayKey, dayStartIso } from './time';
import { DOC, SCOPES, type Config, type Cursor, type Entry, type Item } from './types';

const DAY = 24 * 60 * 60 * 1000;
const BACKFILLS = [7, 30, 90, 365] as const;
const TOKEN_URL = `https://github.com/settings/tokens/new?scopes=${SCOPES.join(',')}&description=Kia`;

export function snapBackfill(v: unknown): Config['backfillDays'] {
  const n = Number(String(v ?? '').trim());
  if (!String(v ?? '').trim() || !Number.isFinite(n) || n <= 0) return 30;
  return BACKFILLS.reduce((best, b) => (Math.abs(b - n) < Math.abs(best - n) ? b : best), 30 as Config['backfillDays']);
}

function promptSchema(withBackfill: boolean) {
  return {
    type: 'object',
    description:
      'Kia indexes your GitHub activity — commit messages and metadata, issues, pull requests, reviews, comments, releases and project boards. It never reads code or diffs. ' +
      'Leave the token empty to sign in with GitHub. Already connected? Use Reconnect to switch sign-in method.',
    'x-steps': [
      { title: 'Sign in with GitHub', body: 'Leave the token field empty and continue — a GitHub sign-in window opens.' },
      {
        title: 'Or use a personal access token',
        body: `Create a classic token with these scopes:\n${SCOPES.join('\n')}`,
        link: TOKEN_URL,
        copy: SCOPES.join(','),
      },
    ],
    properties: {
      password: { type: 'string', title: 'Personal access token (optional)', format: 'password', examples: ['ghp_…'], description: 'Leave empty to sign in with GitHub.' },
      ...(withBackfill
        ? { backfillDays: { type: 'string', title: 'Import history (days)', examples: ['30'], description: 'How far back to import: 7, 30, 90 or 365 days.' } }
        : {}),
    },
  };
}

interface GhUser { login: string; id: number }

export function createGitHubSource(
  host: HostFor<'net' | 'query'>,
  seams: { sleep?: (ms: number) => Promise<void>; now?: () => number; tz?: string } = {},
): Source<Cursor, Item> {
  const now = seams.now ?? Date.now;
  const client = (token: string, signal?: AbortSignal, log?: (m: string) => void) =>
    new GitHubClient({ fetch: host.net.fetch, token, sleep: seams.sleep, signal, log, now });

  /** Prompt → token (OAuth when empty) → verified identity. */
  async function signIn(auth: AuthChannel, withBackfill: boolean) {
    const answers = await auth.prompt(promptSchema(withBackfill));
    const typed = typeof answers.password === 'string' ? answers.password.trim() : '';
    let token: string;
    if (typed) {
      if (!/^(ghp_|github_pat_|gho_)/.test(typed)) throw new Error('that does not look like a GitHub token (ghp_…, github_pat_…)');
      token = typed;
    } else {
      const creds = await auth.oauth(SCOPES);
      if (!creds.accessToken) throw new Error('GitHub sign-in returned no token');
      token = creds.accessToken;
    }
    const c = client(token);
    const { data: me, headers } = await c.rest<GhUser>('/user');
    const scopes = headers['x-oauth-scopes'];
    if (scopes != null && !scopes.split(/,\s*/).includes('repo')) throw new Error('the token is missing the "repo" scope');
    return { c, me, answers };
  }

  const source: Source<Cursor, Item> = {
    descriptor: {
      id: 'github',
      name: 'GitHub',
      documentTypes: Object.values(DOC),
      auth: 'oauth',
      multiAccount: true,
      cadence: { every: '15m' },
      folderScope: true,
    },

    async connect(auth) {
      const { c, me, answers } = await signIn(auth, true);
      auth.status('Loading your repositories…');
      const inv = await loadInventory(c);
      const picked = await auth.pickFolders(pickerSpec({ c, me: me.login, inv, purpose: 'connect' }));
      if (!picked.length) throw new Error('pick at least one account, organization, repository or board');
      const config: Config = {
        login: me.login,
        userId: me.id,
        folderRoots: picked.map((n) => ({ id: n.id, name: n.name })),
        backfillDays: snapBackfill(answers.backfillDays),
      };
      return { identifier: me.login, config };
    },

    async reauthenticate(account, auth) {
      const { me } = await signIn(auth, false);
      const cfg = account.config as unknown as Config;
      if (me.id !== cfg.userId) throw new IdentityMismatchError(`signed in as ${me.login}, but this account is ${account.identifier}`);
    },

    async manageFolders(session, channel) {
      const cfg = session.account.config as unknown as Config;
      const cursor = (session.account.cursor as Cursor | null) ?? null;
      const token = await tokenOf(session);
      const c = client(token, session.signal);
      const inv = await loadInventory(c);
      const picked = await channel.pickFolders(pickerSpec({ c, me: cfg.login, inv, purpose: 'manage', selected: cfg.folderRoots }));
      if (!picked.length) throw new Error('pick at least one account, organization, repository or board');
      const roots = picked.map((n) => ({ id: n.id, name: n.name }));

      // Re-read AFTER the picker closed: a leaf first synced while it was
      // open must still be archived if its owner was unticked.
      const fresh = await loadInventory(c);
      const typeOf = ownerTypeLookup(fresh, cursor);
      const known = new Set<string>([
        ...Object.keys(cursor?.repos ?? {}).map(repoLeaf),
        ...Object.keys(cursor?.projects ?? {}).map((k) => `project:${k}`),
        ...fresh.map((r) => repoLeaf(r.full)),
      ]);
      for (const owner of ownersCoveredBy(cfg.folderRoots)) {
        try {
          for (const b of await loadBoards(c, owner, typeOf(owner) ?? 'Organization', cfg.login)) known.add(boardLeaf(owner, b.number));
        } catch {
          /* boards unavailable for this owner: cursor leaves still count */
        }
      }
      const archive = archiveSet(known, roots, cfg.login, (full) => typeOf(full.split('/')[0]));
      let next: Cursor | null = null;
      if (cursor) {
        next = structuredClone(cursor);
        for (const leaf of archive) {
          if (leaf.startsWith('repo:')) delete next.repos[leaf.slice(5)];
          else delete next.projects[leaf.slice(8)];
        }
      }
      return { config: { ...cfg, folderRoots: roots }, cursor: next, archiveScopeRootIds: archive };
    },

    async *pull(session, cursorIn) {
      const cfg = session.account.config as unknown as Config;
      const log = (m: string) => session.log('info', m);
      const c = client(await tokenOf(session), session.signal, log);
      const cur: Cursor = cursorIn
        ? structuredClone(cursorIn)
        : { v: 1, phase: 'backfill', tz: seams.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone, repos: {}, projects: {} };
      const tz = cur.tz;
      const passStart = new Date(now()).toISOString();
      const horizonNew = new Date(now() - cfg.backfillDays * DAY).toISOString();
      const roots = cfg.folderRoots;
      const me = cfg.login;
      const snap = () => structuredClone(cur);

      // 1. inventory; register new leaves first (cursor-only batch).
      const inv = await loadInventory(c);
      const typeOf = (full: string) => inv.find((r) => r.full === full)?.ownerType ?? cur.repos[full]?.ownerType;
      const covered = inv.filter((r) => covers(roots, repoLeaf(r.full), me, typeOf));
      let registered = false;
      for (const r of covered) {
        if (!cur.repos[r.full]) {
          cur.repos[r.full] = { ownerType: r.ownerType, horizon: horizonNew, pushedAt: '', branchHeads: {}, itemsSyncedTo: horizonNew };
          registered = true;
        }
      }
      if (registered) yield { phase: cur.phase, items: [], cursor: snap() };

      const led = makeLedgers(async (id, type) => {
        const d = await host.query.byExternalId(session.account.id, id, type);
        return ((d?.metadata as { ledger?: Entry[] } | undefined)?.ledger ?? null) as Entry[] | null;
      });
      const blocked = new Set<string>();
      const okOwners = new Set<string>();
      const block = (owner: string, e: OrgBlockedError) => {
        blocked.add(owner);
        const prev = cur.orgsBlocked?.[owner]?.url;
        if (prev !== e.url || !cur.orgsBlocked?.[owner]) log(`github: Authorize Kia for ${owner}: ${e.url ?? 'https://github.com/settings/connections/applications'}`);
        cur.orgsBlocked = { ...(cur.orgsBlocked ?? {}), [owner]: { url: e.url } };
      };
      const flush = async (kind: DayKind, leaf: string, meta: { title?: string; url?: string } = {}): Promise<DocumentInput[]> => {
        const prefix = kind === 'repo' ? `${leaf}:` : `${leaf.split('/')[0]}/project/${leaf.split('/')[1]}:`;
        const out: DocumentInput[] = [];
        for (const [key, ledger] of await led.take(prefix)) out.push(renderDay({ kind, leaf, day: key.slice(prefix.length), tz, ledger, ...meta }));
        return out;
      };
      // Leaves absent upstream are simply not in `covered`: state and docs kept.
      const gone = new Set<string>();
      const available = () => covered.filter((r) => !gone.has(r.full) && !blocked.has(r.owner));

      // 2. commits, push-gated; one batch per repo.
      for (const r of available()) {
        const st = cur.repos[r.full];
        const pushed = !!r.pushedAt && r.pushedAt !== st.pushedAt;
        try {
          if (pushed) await syncCommits(c, r, st, tz, led);
          okOwners.add(r.owner);
        } catch (e) {
          if (e instanceof OrgBlockedError) block(r.owner, e);
          else if (e instanceof NotFoundError) gone.add(r.full);
          else throw e;
          continue;
        }
        const items = await flush('repo', r.full);
        if (pushed) yield { phase: cur.phase, items, cursor: snap() };
      }

      // 3. releases (window-replayed; failures are skipped and retried next pass).
      await syncReleases(c, available(), cur.repos, tz, led, log);
      // 4. touched issues/PRs.
      const releaseDocs: DocumentInput[] = [];
      for (const r of covered) releaseDocs.push(...(await flush('repo', r.full)));
      if (releaseDocs.length) yield { phase: cur.phase, items: releaseDocs, cursor: snap() };
      for (const g of searchGroups(available(), roots, cur.repos)) {
        let docs: DocumentInput[];
        try {
          docs = await syncItems(c, g, cur.repos, tz, led, passStart, log);
        } catch (e) {
          if (e instanceof OrgBlockedError) {
            for (const full of g.repos) block(full.split('/')[0], e);
            continue;
          }
          throw e;
        }
        for (const full of g.repos) docs.push(...(await flush('repo', full)));
        yield { phase: cur.phase, items: docs, cursor: snap() };
      }

      // 5. boards.
      const boardOwners = ownersCoveredBy(roots).filter((o) => !blocked.has(o));
      let scopesOk = true;
      for (const owner of boardOwners) {
        if (!scopesOk) break;
        let boards: InvBoard[];
        try {
          boards = await loadBoards(c, owner, inv.find((r) => r.owner === owner)?.ownerType ?? 'Organization', me);
        } catch (e) {
          if (e instanceof InsufficientScopesError) {
            scopesOk = false;
            if (!cur.projectsUnavailable) log('github: project boards skipped — the token lacks the read:project scope');
            cur.projectsUnavailable = true;
            break;
          }
          if (e instanceof OrgBlockedError) block(owner, e);
          else if (!(e instanceof NotFoundError)) throw e;
          continue;
        }
        for (const board of boards) {
          const leafKey = `${owner}/${board.number}`;
          if (!covers(roots, boardLeaf(owner, board.number), me, typeOf)) continue;
          try {
            const batch = await syncBoard(board, leafKey);
            if (batch) yield batch;
          } catch (e) {
            if (e instanceof OrgBlockedError) {
              block(owner, e);
              break;
            }
            if (e instanceof NotFoundError) continue;
            throw e;
          }
        }
      }
      if (scopesOk) delete cur.projectsUnavailable;
      for (const o of okOwners) if (!blocked.has(o) && cur.orgsBlocked?.[o]) delete cur.orgsBlocked[o];
      if (cur.orgsBlocked && !Object.keys(cur.orgsBlocked).length) delete cur.orgsBlocked;

      if (cur.phase === 'backfill') cur.phase = 'live';
      yield { phase: cur.phase, items: [], cursor: snap() };

      async function syncBoard(board: InvBoard, leafKey: string) {
        let st = cur.projects[leafKey];
        const docId = `${board.owner}/project/${board.number}`;
        const prevDoc = await host.query.byExternalId(session.account.id, docId, DOC.project);
        let restored: DocumentInput[] = [];
        if (!st) {
          // (Re-)registered board: bring back its archived day docs.
          if (prevDoc) {
            const fromDate = dayStartIso(dayKey(horizonNew, tz), tz);
            restored = await restoreBoardDays(
              (offset) => host.query.search({ type: DOC.projectDay, account: session.account.id, includeArchived: true, fromDate, limit: 500, offset }),
              board.owner,
              board.number,
            );
          }
          st = { horizon: horizonNew, updatedAt: '' };
        }
        if (board.updatedAt === st.updatedAt && !restored.length) return null;
        const { items: scanned, statusOrder } = await scanBoard(c, board);
        const prev = ((prevDoc?.metadata as { snapshot?: BoardSnapshot } | undefined)?.snapshot ?? null) as BoardSnapshot | null;
        for (const e of diffBoard(prev, scanned, st.horizon)) led.put(`${docId}:${dayKey(e.at, tz)}`, 'github.project_day', [e]);
        const days = await flush('board', leafKey, { title: board.title, url: board.url });
        // Restored docs whose day was also re-rendered are superseded by it.
        const fresh = new Set(days.map((d) => d.externalId));
        st.updatedAt = board.updatedAt;
        cur.projects[leafKey] = st;
        // github.project (the snapshot) LAST: core flattens this array and
        // sub-commits per 50 docs, so a crash must never persist the new
        // snapshot ahead of its day docs.
        const aggregate: DocumentInput[] = [...restored.filter((d) => !fresh.has(d.externalId)), ...days, renderBoard(board, toSnapshot(scanned, passStart, statusOrder))];
        return { phase: cur.phase, items: aggregate, cursor: snap() };
      }
    },

    toDocument(item) {
      return item;
    },
  };
  return source;
}

async function tokenOf(session: { credentials(): Promise<{ accessToken?: string; password?: string } | null> }): Promise<string> {
  const creds = await session.credentials();
  const token = creds?.accessToken || creds?.password;
  if (!token) throw new SourceAuthError('github: no token stored for this account');
  return token;
}

/** Owners whose boards `roots` can cover. */
function ownersCoveredBy(roots: { id: string }[]): string[] {
  const out = new Set<string>();
  for (const r of roots) {
    const owner = /^(?:acct|org|projects):(.+)$/.exec(r.id)?.[1] ?? /^project:([^/]+)\//.exec(r.id)?.[1];
    if (owner) out.add(owner);
  }
  return [...out];
}

function ownerTypeLookup(inv: InvRepo[], cursor: Cursor | null) {
  return (owner: string): OwnerType | undefined =>
    inv.find((r) => r.owner === owner)?.ownerType ?? Object.entries(cursor?.repos ?? {}).find(([k]) => k.split('/')[0] === owner)?.[1].ownerType;
}

