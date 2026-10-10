import type { FolderNode, FolderPickerSpec } from '@kiagent/connector-sdk';
import { InsufficientScopesError, NotFoundError, OrgBlockedError, type GitHubClient } from './client';

export type OwnerType = 'User' | 'Organization';

export interface InvRepo {
  full: string;
  owner: string;
  ownerType: OwnerType;
  pushedAt: string;
  defaultBranch: string;
  archived: boolean;
}

export interface InvBoard {
  owner: string;
  number: number;
  title: string;
  id: string;
  url: string;
  createdAt: string;
  shortDescription: string | null;
  updatedAt: string;
  closed: boolean;
  ownerType: OwnerType;
}

/* Node ids: roots `acct:<me>` `org:<O>` `shared`; groups `projects:<O>`;
 * leaves `repo:<o>/<n>` `project:<o>/<num>`. Every scopeRootId is a leaf. */

export const repoLeaf = (full: string) => `repo:${full}`;
export const boardLeaf = (owner: string, number: number | string) => `project:${owner}/${number}`;

interface GhRepo {
  full_name: string;
  owner: { login: string; type: string };
  pushed_at: string | null;
  default_branch: string;
  archived: boolean;
}

export async function loadInventory(c: GitHubClient): Promise<InvRepo[]> {
  const out: InvRepo[] = [];
  for await (const p of c.restPages<GhRepo>('/user/repos', { affiliation: 'owner,collaborator,organization_member', sort: 'pushed' })) {
    for (const r of p.data) {
      out.push({
        full: r.full_name,
        owner: r.owner.login,
        ownerType: r.owner.type === 'Organization' ? 'Organization' : 'User',
        pushedAt: r.pushed_at ?? '',
        defaultBranch: r.default_branch,
        archived: r.archived,
      });
    }
  }
  return out;
}

const BOARD_FIELDS = 'nodes{ id number title url createdAt shortDescription updatedAt closed }';

/** Open boards of one owner. The viewer's own boards come from `viewer`. */
export async function loadBoards(c: GitHubClient, owner: string, ownerType: OwnerType, me: string): Promise<InvBoard[]> {
  type N = { id: string; number: number; title: string; url: string; createdAt: string; shortDescription: string | null; updatedAt: string; closed: boolean };
  let nodes: N[];
  if (owner === me) {
    const d = await c.graphql<{ viewer: { projectsV2: { nodes: N[] } } }>(`query{ viewer{ projectsV2(first:100){ ${BOARD_FIELDS} } } }`);
    nodes = d.viewer.projectsV2.nodes;
  } else if (ownerType === 'Organization') {
    const d = await c.graphql<{ organization: { projectsV2: { nodes: N[] } } | null }>(`query($login:String!){ organization(login:$login){ projectsV2(first:100){ ${BOARD_FIELDS} } } }`, { login: owner });
    nodes = d.organization?.projectsV2.nodes ?? [];
  } else {
    return [];
  }
  return nodes.filter((n) => n && !n.closed).map((n) => ({ ...n, owner, ownerType }));
}

/** Pure coverage: does any root in `roots` cover `leaf`? (spec §5.2) */
export function covers(roots: { id: string }[], leaf: string, me: string, ownerTypeOf: (full: string) => OwnerType | undefined): boolean {
  const m = /^(repo|project):([^/]+)\/(.+)$/.exec(leaf);
  if (!m) return false;
  const [, kind, owner, rest] = m;
  return roots.some((r) => {
    if (r.id === leaf) return true;
    if (r.id === `acct:${owner}` || r.id === `org:${owner}`) return true;
    if (kind === 'project' && r.id === `projects:${owner}`) return true;
    if (kind === 'repo' && r.id === 'shared') return owner !== me && ownerTypeOf(`${owner}/${rest}`) === 'User';
    return false;
  });
}

/** Leaves in `known` that the new roots no longer cover (the archive set). */
export function archiveSet(known: Iterable<string>, newRoots: { id: string }[], me: string, ownerTypeOf: (full: string) => OwnerType | undefined): string[] {
  return [...new Set(known)].filter((leaf) => !covers(newRoots, leaf, me, ownerTypeOf));
}

/** Ancestors of each selected node, so the manage picker opens on them. */
export function expandFor(selected: { id: string }[], me: string, ownerTypeOf: (full: string) => OwnerType | undefined): string[] {
  const out = new Set<string>();
  for (const s of selected) {
    const m = /^(repo|project):([^/]+)\/(.+)$/.exec(s.id);
    if (!m) continue;
    const [, kind, owner, rest] = m;
    const root = owner === me ? `acct:${me}` : kind === 'repo' && ownerTypeOf(`${owner}/${rest}`) === 'User' ? 'shared' : `org:${owner}`;
    out.add(root);
    if (kind === 'project') out.add(`projects:${owner}`);
  }
  return [...out];
}

export function pickerSpec(a: {
  c: GitHubClient;
  me: string;
  inv: InvRepo[];
  purpose: 'connect' | 'manage';
  selected?: { id: string; name: string }[];
}): FolderPickerSpec {
  const { c, me, inv } = a;
  const ownerType = new Map(inv.map((r) => [r.owner, r.ownerType] as const));
  const typeOf = (full: string) => inv.find((r) => r.full === full)?.ownerType;
  const orgs = [...new Set(inv.filter((r) => r.ownerType === 'Organization').map((r) => r.owner))].sort((x, y) => x.localeCompare(y));
  const sharedRepos = inv.filter((r) => r.ownerType === 'User' && r.owner !== me);
  const repoNode = (r: InvRepo): FolderNode => ({ id: repoLeaf(r.full), name: r.full + (r.archived ? ' (archived)' : ''), hasChildren: false });

  const selected = (a.selected ?? []).map((s) => ({ id: s.id, name: s.name, hasChildren: !s.id.startsWith('repo:') && !s.id.startsWith('project:') }));
  return {
    modes: [{ key: 'repos', label: 'Accounts, repositories and boards' }],
    multiSelect: true,
    purpose: a.purpose,
    selected,
    expand: expandFor(selected, me, typeOf),
    note: a.purpose === 'manage' ? 'Activity from repositories and boards you untick is removed from Kia.' : undefined,
    async roots() {
      const roots: FolderNode[] = [{ id: `acct:${me}`, name: `${me} (your account)`, hasChildren: true }];
      for (const o of orgs) roots.push({ id: `org:${o}`, name: o, hasChildren: true });
      if (sharedRepos.length) roots.push({ id: 'shared', name: 'Shared with you', hasChildren: true });
      return roots;
    },
    async children(id: string) {
      if (id === 'shared') return sharedRepos.map(repoNode);
      const root = /^(acct|org):(.+)$/.exec(id);
      if (root) {
        const owner = root[2];
        return [{ id: `projects:${owner}`, name: 'Projects (boards)', hasChildren: true }, ...inv.filter((r) => r.owner === owner).map(repoNode)];
      }
      const group = /^projects:(.+)$/.exec(id);
      if (group) {
        const owner = group[1];
        let boards: InvBoard[];
        try {
          boards = await loadBoards(c, owner, owner === me ? 'User' : (ownerType.get(owner) ?? 'Organization'), me);
        } catch (e) {
          // No read:project, SSO-blocked org: an empty group, never a broken picker.
          if (e instanceof InsufficientScopesError || e instanceof OrgBlockedError || e instanceof NotFoundError) return [];
          throw e;
        }
        return boards.map((b) => ({ id: boardLeaf(owner, b.number), name: `#${b.number} ${b.title}`, hasChildren: false }));
      }
      return [];
    },
  };
}
