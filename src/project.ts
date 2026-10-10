import type { DocumentInput } from '@kiagent/connector-sdk';
import { NotFoundError, type GitHubClient } from './client';
import type { InvBoard } from './scope';
import type { Entry } from './types';

export interface SnapContent {
  id: string | null;
  type: 'Issue' | 'PullRequest' | 'DraftIssue' | 'REDACTED';
  repo?: string;
  number?: number;
  title: string;
  url?: string;
}
export interface SnapItem {
  content: SnapContent;
  status: string | null;
  iteration: string | null;
  assignees: string[];
  createdAt: string;
  creator: string;
}
export interface BoardSnapshot {
  scannedAt: string;
  statusOrder: string[];
  items: Record<string, SnapItem>;
}
interface FieldValue { name: string; updatedAt: string; creator: string }
export interface ScannedItem extends SnapItem {
  id: string;
  statusValue: FieldValue | null;
  iterationValue: FieldValue | null;
}

/* ------------------------------------------------------------------ scan */

const ITEMS = `query($id:ID!,$c:String){ node(id:$id){ ... on ProjectV2{
  fields(first:30){ nodes{ ... on ProjectV2SingleSelectField{ name options{ name } } } }
  items(first:100, after:$c){ nodes{ id createdAt creator{ login } type
    content{
      ... on Issue{ id number title url repository{ nameWithOwner } assignees(first:10){ nodes{ login } } }
      ... on PullRequest{ id number title url repository{ nameWithOwner } assignees(first:10){ nodes{ login } } }
      ... on DraftIssue{ id title assignees(first:10){ nodes{ login } } } }
    fieldValues(first:20){ nodes{ __typename
      ... on ProjectV2ItemFieldSingleSelectValue{ name updatedAt creator{ login } field{ ... on ProjectV2FieldCommon{ name } } }
      ... on ProjectV2ItemFieldIterationValue{ title updatedAt creator{ login } field{ ... on ProjectV2FieldCommon{ name } } } } } }
    pageInfo{ hasNextPage endCursor } } } } }`;

type RawFV = { __typename: string; name?: string; title?: string; updatedAt?: string; creator?: { login: string } | null; field?: { name?: string } };
type RawItem = {
  id: string;
  createdAt: string;
  creator: { login: string } | null;
  type: string;
  content: { id?: string; number?: number; title?: string; url?: string; repository?: { nameWithOwner: string }; assignees?: { nodes: { login: string }[] } } | null;
  fieldValues: { nodes: RawFV[] };
};

export async function scanBoard(c: GitHubClient, board: InvBoard): Promise<{ items: ScannedItem[]; statusOrder: string[] }> {
  const items: ScannedItem[] = [];
  let statusOrder: string[] = [];
  let after: string | null = null;
  for (let first = true; ; first = false) {
    const d: { node: { fields: { nodes: ({ name?: string; options?: { name: string }[] } | null)[] }; items: { nodes: RawItem[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } | null } = await c.graphql(ITEMS, { id: board.id, c: after });
    // Never an empty scan: that would read as "every item removed".
    if (!d.node) throw new NotFoundError(`board ${board.owner}/${board.number}`);
    if (first) statusOrder = d.node.fields.nodes.find((f) => f?.name === 'Status')?.options?.map((o) => o.name) ?? [];
    for (const n of d.node.items.nodes) {
      const fv = n.fieldValues.nodes;
      const st = fv.find((v) => v.__typename === 'ProjectV2ItemFieldSingleSelectValue' && v.field?.name === 'Status');
      const it = fv.find((v) => v.__typename === 'ProjectV2ItemFieldIterationValue');
      const val = (v: RawFV | undefined, label: string | undefined): FieldValue | null => (v && label ? { name: label, updatedAt: v.updatedAt ?? n.createdAt, creator: v.creator?.login ?? 'Unknown' } : null);
      items.push({
        id: n.id,
        createdAt: n.createdAt,
        creator: n.creator?.login ?? 'Unknown',
        content: {
          id: n.content?.id ?? null,
          type: (n.type as SnapContent['type']) ?? 'DraftIssue',
          repo: n.content?.repository?.nameWithOwner,
          number: n.content?.number,
          title: n.content?.title ?? '(no access)',
          url: n.content?.url,
        },
        assignees: n.content?.assignees?.nodes.map((a) => a.login) ?? [],
        status: st?.name ?? null,
        iteration: it?.title ?? null,
        statusValue: val(st, st?.name),
        iterationValue: val(it, it?.title),
      });
    }
    if (!d.node.items.pageInfo.hasNextPage) break;
    after = d.node.items.pageInfo.endCursor;
  }
  return { items, statusOrder };
}

export function toSnapshot(scanned: ScannedItem[], scannedAt: string, statusOrder: string[]): BoardSnapshot {
  const items: Record<string, SnapItem> = {};
  for (const { id, statusValue: _s, iterationValue: _i, ...rest } of scanned) items[id] = rest;
  return { scannedAt, statusOrder, items };
}

/* ------------------------------------------------------------------ diff */

const label = (c: SnapContent) => (c.number != null && c.url ? `[#${c.number}](${c.url}) ${c.title}` : c.title);

/** Board change entries (spec §6.2 step 5, §6.3). Every key is derived from
 *  GitHub data or the PRIOR snapshot — never the wall clock — so replaying
 *  the same diff (a crash before the snapshot doc committed) yields the same
 *  keys AND the same days. Clears/removals are therefore also DATED at the
 *  prior snapshot's scannedAt (the latest time they were not yet observed). */
export function diffBoard(prev: BoardSnapshot | null, now: ScannedItem[], horizon: string): Entry[] {
  const out: Entry[] = [];
  const fields = [
    ['Status', 'status', 'statusValue'],
    ['Iteration', 'iteration', 'iterationValue'],
  ] as const;
  for (const it of now) {
    const old = prev?.items[it.id];
    const name = label(it.content);
    let moved = false;
    for (const [field, key, valueKey] of fields) {
      const v = it[valueKey];
      if (!old) {
        // First sight of the item (first scan, or added since the last one):
        // only a value changed AFTER the item was added is a move.
        if (v && v.updatedAt > it.createdAt) {
          out.push({ id: `move:${it.id}:${field}:${v.name}@${v.updatedAt}`, at: v.updatedAt, actor: v.creator, text: `moved ${name} to ${v.name}` });
          moved = true;
        }
        continue;
      }
      if (v && old[key] !== v.name) {
        out.push({ id: `move:${it.id}:${field}:${v.name}@${v.updatedAt}`, at: v.updatedAt, actor: v.creator, text: `moved ${name} ${old[key] ?? '(none)'} → ${v.name}` });
      } else if (!v && old[key] != null) {
        out.push({ id: `cleared:${it.id}:${field}@${prev.scannedAt}`, at: prev.scannedAt, actor: 'Unknown', text: `cleared ${field} of ${name} (was ${old[key]})` });
      }
    }
    if (!old) {
      const where = !moved && it.status ? ` in ${it.status}` : '';
      out.push({ id: `added:${it.id}@${it.createdAt}`, at: it.createdAt, actor: it.creator, text: `added ${name}${where}` });
    }
  }
  if (prev) {
    const live = new Set(now.map((i) => i.id));
    for (const [id, old] of Object.entries(prev.items)) {
      if (!live.has(id)) out.push({ id: `removed:${id}@${prev.scannedAt}`, at: prev.scannedAt, actor: 'Unknown', text: `removed ${label(old.content)}` });
    }
  }
  return out.filter((e) => e.at >= horizon);
}

/* ---------------------------------------------------------------- render */

export function renderBoard(board: InvBoard, snap: BoardSnapshot): DocumentInput {
  const cols = new Map<string, SnapItem[]>();
  for (const s of snap.statusOrder) cols.set(s, []);
  const none: SnapItem[] = [];
  for (const it of Object.values(snap.items)) {
    if (it.status == null) none.push(it);
    else cols.set(it.status, [...(cols.get(it.status) ?? []), it]);
  }
  const lines = [`# ${board.title}`, '', `- Board: ${board.url}`, `- Owner: ${board.owner}`];
  if (board.shortDescription) lines.push(`- ${board.shortDescription}`);
  const col = (name: string, items: SnapItem[]) => {
    if (!items.length) return;
    lines.push('', `## ${name} (${items.length})`);
    for (const it of items) {
      const where = it.content.repo ? ` (${it.content.repo})` : '';
      const who = it.assignees.length ? ` — ${it.assignees.map((a) => '@' + a).join(' ')}` : '';
      lines.push(`- ${label(it.content)}${where}${who}${it.iteration ? ` · ${it.iteration}` : ''}`);
    }
  };
  for (const [name, items] of cols) col(name, items);
  col('No status', none);

  const participants = new Set<string>();
  for (const it of Object.values(snap.items)) {
    for (const a of it.assignees) participants.add(a);
    if (it.creator !== 'Unknown') participants.add(it.creator);
  }
  return {
    externalId: `${board.owner}/project/${board.number}`,
    type: 'github.project',
    title: `${board.title} (${board.owner} board #${board.number})`,
    markdown: lines.join('\n'),
    url: board.url,
    createdAt: board.createdAt,
    scopeRootId: `project:${board.owner}/${board.number}`,
    metadata: { owner: board.owner, number: board.number, snapshot: snap, participants: [...participants] },
  };
}

/* --------------------------------------------------------------- restore */

export interface StoredDoc {
  externalId: string;
  type: string;
  title: string | null;
  markdown: string | null;
  url?: string;
  metadata: Record<string, unknown>;
  createdAt: string | null;
}

/** Re-emit a re-ticked board's archived day docs (within retention) so they
 *  come back live. Pages the core search (cap 500) until a short page. */
export async function restoreBoardDays(search: (offset: number) => Promise<StoredDoc[]>, owner: string, number: number): Promise<DocumentInput[]> {
  const prefix = `${owner}/project/${number}:`;
  const out: DocumentInput[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await search(offset);
    for (const d of page) {
      if (!d.externalId.startsWith(prefix)) continue;
      out.push({ externalId: d.externalId, type: d.type, title: d.title, markdown: d.markdown, url: d.url, metadata: d.metadata, createdAt: d.createdAt, scopeRootId: `project:${owner}/${number}` });
    }
    if (page.length < 500) return out;
  }
}
