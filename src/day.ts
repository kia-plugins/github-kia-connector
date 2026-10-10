import type { DocumentInput } from '@kiagent/connector-sdk';
import { participantsOf, primaryActor } from './people';
import { dayStartIso, hhmm } from './time';
import { DOC, type Entry } from './types';

const MAX_BODY = 512 * 1024;

/** Dedupe by id (incoming wins), sorted by time then id. */
export function mergeLedger(prior: Entry[] | null, incoming: Entry[]): Entry[] {
  const m = new Map<string, Entry>();
  for (const e of prior ?? []) m.set(e.id, e);
  for (const e of incoming) m.set(e.id, e);
  return [...m.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type DayKind = 'repo' | 'board';

/** externalId of a day doc. repo leaf "o/n"; board leaf "o/<number>". */
export function dayKeyOf(kind: DayKind, leaf: string, day: string): string {
  if (kind === 'repo') return `${leaf}:${day}`;
  const [owner, number] = leaf.split('/');
  return `${owner}/project/${number}:${day}`;
}

export function renderDay(a: { kind: DayKind; leaf: string; title?: string; url?: string; day: string; tz: string; ledger: Entry[] }): DocumentInput {
  const groups = new Map<string, Entry[]>();
  for (const e of a.ledger) {
    const g = groups.get(e.actor) ?? [];
    g.push(e);
    groups.set(e.actor, g);
  }
  const order = [...groups.keys()].filter((k) => k !== 'Unknown');
  if (groups.has('Unknown')) order.push('Unknown');

  const name = a.kind === 'repo' ? a.leaf : (a.title ?? a.leaf);
  const head = `# ${name} — ${a.day}\n`;
  const lines: string[] = [];
  for (const actor of order) {
    lines.push('', `## ${actor}`);
    for (const e of groups.get(actor)!) {
      lines.push(`- ${hhmm(e.at, a.tz)} ${e.text}`);
      if (e.detail) lines.push(...e.detail.split('\n').map((l) => `    ${l}`));
    }
  }
  let body = head + lines.join('\n');
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY) {
    let dropped = 0;
    while (lines.length && Buffer.byteLength(head + lines.join('\n'), 'utf8') > MAX_BODY - 64) {
      const l = lines.pop()!;
      if (l.startsWith('- ')) dropped++;
    }
    body = head + lines.join('\n') + `\n… +${dropped} more entries`;
  }

  const primary = primaryActor(a.ledger);
  const isRepo = a.kind === 'repo';
  return {
    externalId: dayKeyOf(a.kind, a.leaf, a.day),
    type: isRepo ? DOC.day : DOC.projectDay,
    title: `${name} — ${a.day}`,
    markdown: body,
    url: isRepo ? `https://github.com/${a.leaf}/pulse` : a.url,
    createdAt: dayStartIso(a.day, a.tz),
    scopeRootId: `${isRepo ? 'repo' : 'project'}:${a.leaf}`,
    metadata: {
      [isRepo ? 'repo' : 'board']: a.leaf,
      day: a.day,
      ledger: a.ledger,
      from: primary,
      author: primary,
      participants: participantsOf(a.ledger),
    },
  };
}
