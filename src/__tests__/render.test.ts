import { dayKeyOf, mergeLedger, renderDay } from '../day';
import { itemEntries, renderItem, type FullItem } from '../item';
import type { Entry } from '../types';

const tz = 'Europe/Berlin';
const e = (id: string, at: string, actor: string, extra: Partial<Entry> = {}): Entry => ({ id, at, actor, text: `did ${id}`, ...extra });

describe('mergeLedger', () => {
  it('is idempotent and incoming wins', () => {
    const a = [e('1', '2026-10-08T08:00:00Z', 'A'), e('2', '2026-10-08T09:00:00Z', 'A')];
    const b = [e('2', '2026-10-08T09:00:00Z', 'A', { text: 'new' }), e('0', '2026-10-08T07:00:00Z', 'B')];
    const m = mergeLedger(a, b);
    expect(mergeLedger(m, b)).toEqual(m);
    expect(m.map((x) => x.id)).toEqual(['0', '1', '2']);
    expect(m[2].text).toBe('new');
  });
});

describe('renderDay', () => {
  const ledger = [
    e('c1', '2026-10-08T07:00:00Z', 'Alice <alice>', { emails: ['alice@x.io', 'bob@x.io'], detail: 'body line' }),
    e('u1', '2026-10-08T07:30:00Z', 'Unknown'),
    e('c2', '2026-10-08T08:00:00Z', 'Bob <bob>'),
    e('c3', '2026-10-08T09:00:00Z', 'Alice <alice>'),
  ];
  it('repo day: grouping, stamps, createdAt, metadata', () => {
    const d = renderDay({ kind: 'repo', leaf: 'acme/api', day: '2026-10-08', tz, ledger });
    expect(d.externalId).toBe('acme/api:2026-10-08');
    expect(d.type).toBe('github.day');
    expect(d.scopeRootId).toBe('repo:acme/api');
    expect(d.createdAt).toBe('2026-10-07T22:00:00.000Z');
    expect(d.metadata.from).toBe('Alice <alice>');
    expect(d.metadata.participants).toEqual(expect.arrayContaining(['bob@x.io', 'Bob <bob>']));
    const md = d.markdown!;
    expect(md.indexOf('## Alice')).toBeLessThan(md.indexOf('## Bob'));
    expect(md.indexOf('## Bob')).toBeLessThan(md.indexOf('## Unknown'));
    expect(md).toContain('- 09:00 did c1\n    body line');
  });
  it('board day: type + stamp', () => {
    const d = renderDay({ kind: 'board', leaf: 'acme/3', title: 'Roadmap', url: 'https://github.com/orgs/acme/projects/3', day: '2026-10-08', tz, ledger });
    expect(d.externalId).toBe('acme/project/3:2026-10-08');
    expect(dayKeyOf('board', 'acme/3', '2026-10-08')).toBe(d.externalId);
    expect(d.type).toBe('github.project_day');
    expect(d.scopeRootId).toBe('project:acme/3');
  });
  it('truncates past 512 KiB but keeps the full ledger', () => {
    const big = Array.from({ length: 3000 }, (_, i) => e(`x${i}`, '2026-10-08T07:00:00Z', 'A', { text: 'y'.repeat(200) }));
    const d = renderDay({ kind: 'repo', leaf: 'a/b', day: '2026-10-08', tz, ledger: big });
    expect(Buffer.byteLength(d.markdown!, 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(d.markdown).toMatch(/… \+\d+ more entries$/);
    expect((d.metadata.ledger as Entry[]).length).toBe(3000);
  });
});

describe('items', () => {
  const pr: FullItem = {
    repo: 'acme/api', number: 7, isPr: true, title: 'Add x', url: 'https://github.com/acme/api/pull/7', state: 'merged',
    author: { login: 'alice', name: 'Alice' }, createdAt: '2026-10-07T10:00:00Z', updatedAt: '2026-10-08T12:00:00Z',
    mergedAt: '2026-10-08T12:00:00Z', mergedBy: { login: 'bob' }, body: 'desc', labels: ['feat'], assignees: [], reviewers: [{ login: 'carol' }],
    base: 'main', head: 'feat/x',
    comments: [
      { id: 2, at: '2026-10-08T09:00:00Z', author: { login: 'dave' }, body: 'later' },
      { id: 1, at: '2026-10-07T11:00:00Z', author: { login: 'erin' }, body: 'first', path: 'a.ts', line: 3 },
    ],
    reviews: [{ id: 5, at: '2026-10-08T08:00:00Z', author: { login: 'carol' }, state: 'APPROVED', body: 'lgtm' }],
  };
  it('renderItem', () => {
    const d = renderItem(pr);
    expect(d.externalId).toBe('acme/api#7');
    expect(d.type).toBe('github.pr');
    expect(d.scopeRootId).toBe('repo:acme/api');
    expect(d.markdown).toContain('- State: merged');
    const md = d.markdown!;
    expect(md.indexOf('erin commented')).toBeLessThan(md.indexOf('carol reviewed'));
    expect(md.indexOf('carol reviewed')).toBeLessThan(md.indexOf('dave commented'));
    expect(d.metadata.participants).toEqual(expect.arrayContaining(['Alice <alice>', 'bob', 'carol', 'dave', 'erin']));
    expect(d.metadata.updatedAt).toBe('2026-10-08T12:00:00Z');
  });
  it('the closer of an issue is a participant', () => {
    const d = renderItem({ ...pr, isPr: false, state: 'closed', mergedAt: null, mergedBy: null, closedAt: '2026-10-08T12:00:00Z', closedBy: { login: 'zoe' } });
    expect(d.metadata.participants).toContain('zoe');
  });
  it('itemEntries has stable ids', () => {
    const ids = itemEntries(pr).map((x) => x.id);
    expect(itemEntries(pr).map((x) => x.id)).toEqual(ids);
    expect(ids).toEqual(expect.arrayContaining(['event:acme/api#7#opened@2026-10-07T10:00:00Z', 'event:acme/api#7#merged@2026-10-08T12:00:00Z', 'comment:1', 'comment:2', 'review:5']));
  });
});
