import type { DocumentInput } from '@kiagent/connector-sdk';
import { actorOf, type Actorish } from './people';
import { DOC, type Entry } from './types';

export interface FullItem {
  repo: string;
  number: number;
  isPr: boolean;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged' | 'draft';
  author: Actorish;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
  closedBy?: Actorish | null;
  mergedAt?: string | null;
  mergedBy?: Actorish | null;
  body: string;
  labels: string[];
  assignees: Actorish[];
  reviewers: Actorish[];
  base?: string;
  head?: string;
  comments: { id: number; at: string; author: Actorish; body: string; path?: string; line?: number | null }[];
  reviews: { id: number; at: string; author: Actorish; state: string; body: string }[];
}

const clip = (s: string, n = 280) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** Day-ledger entries for an item (spec §6.3 keys). */
export function itemEntries(i: FullItem): Entry[] {
  const kind = i.isPr ? 'PR' : 'issue';
  const ref = `[#${i.number}](${i.url})`;
  const key = `${i.repo}#${i.number}`;
  const out: Entry[] = [
    { id: `event:${key}#opened@${i.createdAt}`, at: i.createdAt, actor: actorOf(i.author), text: `opened ${kind} [#${i.number} ${i.title}](${i.url})` },
  ];
  if (i.mergedAt) out.push({ id: `event:${key}#merged@${i.mergedAt}`, at: i.mergedAt, actor: actorOf(i.mergedBy), text: `merged PR ${ref} ${i.title}` });
  else if (i.closedAt && i.state === 'closed') out.push({ id: `event:${key}#closed@${i.closedAt}`, at: i.closedAt, actor: actorOf(i.closedBy), text: `closed ${kind} ${ref} ${i.title}` });
  for (const c of i.comments) out.push({ id: `comment:${c.id}`, at: c.at, actor: actorOf(c.author), text: `commented on ${ref}: "${clip(c.body)}"` });
  for (const r of i.reviews) {
    out.push({ id: `review:${r.id}`, at: r.at, actor: actorOf(r.author), text: `reviewed PR ${ref}: ${r.state.toLowerCase()}${r.body?.trim() ? ` — "${clip(r.body)}"` : ''}` });
  }
  return out;
}

export function renderItem(i: FullItem): DocumentInput {
  const author = actorOf(i.author);
  const header = [
    `# #${i.number} ${i.title}`,
    '',
    `- Repo: ${i.repo}`,
    `- ${i.isPr ? 'Pull request' : 'Issue'} by ${author}, opened ${i.createdAt}`,
    `- State: ${i.state}${i.mergedAt ? ` (merged ${i.mergedAt} by ${actorOf(i.mergedBy)})` : i.closedAt ? ` (closed ${i.closedAt})` : ''}`,
  ];
  if (i.base && i.head) header.push(`- Branches: ${i.head} → ${i.base}`);
  if (i.labels.length) header.push(`- Labels: ${i.labels.join(', ')}`);
  if (i.assignees.length) header.push(`- Assignees: ${i.assignees.map(actorOf).join(', ')}`);
  if (i.reviewers.length) header.push(`- Reviewers: ${i.reviewers.map(actorOf).join(', ')}`);

  const timeline: { at: string; line: string }[] = [];
  for (const c of i.comments) {
    const where = c.path ? ` on \`${c.path}${c.line ? `:${c.line}` : ''}\`` : '';
    timeline.push({ at: c.at, line: `### ${c.at} — ${actorOf(c.author)} commented${where}\n\n${c.body ?? ''}` });
  }
  for (const r of i.reviews) {
    timeline.push({ at: r.at, line: `### ${r.at} — ${actorOf(r.author)} reviewed: ${r.state.toLowerCase()}${r.body?.trim() ? `\n\n${r.body}` : ''}` });
  }
  if (i.mergedAt) timeline.push({ at: i.mergedAt, line: `### ${i.mergedAt} — merged by ${actorOf(i.mergedBy)}` });
  else if (i.closedAt && i.state === 'closed') timeline.push({ at: i.closedAt, line: `### ${i.closedAt} — closed${i.closedBy ? ` by ${actorOf(i.closedBy)}` : ''}` });
  timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const md = [...header, '', '## Description', '', i.body?.trim() || '_No description._', ...(timeline.length ? ['', '## Timeline', '', ...timeline.map((t) => t.line + '\n')] : [])].join('\n');

  const participants = new Set<string>([author]);
  for (const a of [...i.assignees, ...i.reviewers]) participants.add(actorOf(a));
  for (const c of i.comments) participants.add(actorOf(c.author));
  for (const r of i.reviews) participants.add(actorOf(r.author));
  if (i.mergedBy) participants.add(actorOf(i.mergedBy));
  participants.delete('Unknown');

  return {
    externalId: `${i.repo}#${i.number}`,
    type: i.isPr ? DOC.pr : DOC.issue,
    title: `#${i.number} ${i.title} (${i.repo})`,
    markdown: md,
    url: i.url,
    createdAt: i.createdAt,
    scopeRootId: `repo:${i.repo}`,
    metadata: {
      repo: i.repo,
      number: i.number,
      state: i.state,
      merged: !!i.mergedAt,
      author,
      from: author,
      participants: [...participants],
      labels: i.labels,
      updatedAt: i.updatedAt,
    },
  };
}
