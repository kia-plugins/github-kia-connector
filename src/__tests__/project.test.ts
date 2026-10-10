import { NotFoundError } from '../client';
import { fakeGitHub } from './helpers/fake-github';
import { scanBoard, diffBoard, renderBoard, restoreBoardDays, toSnapshot, type ScannedItem } from '../project';
import type { InvBoard } from '../scope';

const Y = '2026-10-08T10:00:00Z';
const horizon = '2026-10-01T00:00:00Z';
const item = (id: string, over: Partial<ScannedItem> = {}): ScannedItem => ({
  id,
  createdAt: '2024-01-01T00:00:00Z',
  creator: 'alice',
  content: { id: 'C' + id, type: 'Issue', repo: 'acme/api', number: 1, title: 'Fix', url: 'https://github.com/acme/api/issues/1' },
  assignees: [],
  status: null,
  iteration: null,
  statusValue: null,
  iterationValue: null,
  ...over,
});
const withStatus = (id: string, s: string, updatedAt: string, over: Partial<ScannedItem> = {}) =>
  item(id, { status: s, statusValue: { name: s, updatedAt, creator: 'bob' }, ...over });

describe('diffBoard first scan', () => {
  it('a value changed after the item was added is one move (value createdAt==updatedAt does not matter); old add dropped', () => {
    const e = diffBoard(null, [withStatus('I', 'Done', Y)], horizon);
    expect(e.map((x) => x.id)).toEqual([`move:I:Status:Done@${Y}`]);
    expect(e[0].actor).toBe('bob');
  });
  it('no later move → added in <status>', () => {
    const t = '2026-10-08T09:00:00Z';
    const e = diffBoard(null, [withStatus('I', 'Todo', t, { createdAt: t })], horizon);
    expect(e.map((x) => [x.id, x.text])).toEqual([[`added:I@${t}`, expect.stringContaining('in Todo')]]);
  });
  it('a two-year-old board emits nothing before the horizon', () => {
    expect(diffBoard(null, [withStatus('I', 'Done', '2024-06-01T00:00:00Z')], horizon)).toEqual([]);
  });
});

describe('diffBoard subsequent scans', () => {
  const prev = toSnapshot([withStatus('I', 'Todo', '2026-10-07T00:00:00Z'), item('R')], '2026-10-08T08:00:00Z', ['Todo', 'Done']);
  it('Todo→Done is keyed on the value updatedAt; replay gives identical keys', () => {
    const now = [withStatus('I', 'Done', Y), item('R')];
    const a = diffBoard(prev, now, horizon);
    expect(a.map((x) => x.id)).toEqual([`move:I:Status:Done@${Y}`]);
    expect(a[0].text).toContain('Todo → Done');
    expect(diffBoard(prev, now, horizon)).toEqual(a);
  });
  it('clear and remove are keyed AND dated on prev.scannedAt', () => {
    const e = diffBoard(prev, [item('I')], horizon);
    expect(e.map((x) => [x.id, x.at, x.actor])).toEqual([
      ['cleared:I:Status@2026-10-08T08:00:00Z', '2026-10-08T08:00:00Z', 'Unknown'],
      ['removed:R@2026-10-08T08:00:00Z', '2026-10-08T08:00:00Z', 'Unknown'],
    ]);
  });
  it('item added AND moved between two polls keeps both the add and the move', () => {
    const e = diffBoard(prev, [withStatus('I', 'Todo', '2026-10-07T00:00:00Z'), item('R'), withStatus('N', 'Done', '2026-10-08T10:12:00Z', { createdAt: '2026-10-08T10:01:00Z' })], horizon);
    expect(e.map((x) => [x.id, x.actor])).toEqual([
      ['move:N:Status:Done@2026-10-08T10:12:00Z', 'bob'],
      ['added:N@2026-10-08T10:01:00Z', 'alice'],
    ]);
  });
  it('new item since last scan → added', () => {
    const e = diffBoard(prev, [withStatus('I', 'Todo', '2026-10-07T00:00:00Z'), item('R'), item('N', { createdAt: Y })], horizon);
    expect(e.map((x) => x.id)).toEqual([`added:N@${Y}`]);
  });
});

describe('renderBoard', () => {
  const board: InvBoard = { owner: 'acme', number: 3, title: 'Roadmap', id: 'P', url: 'https://github.com/orgs/acme/projects/3', createdAt: '2025-01-01T00:00:00Z', shortDescription: 'Q4', updatedAt: Y, closed: false, ownerType: 'Organization' };
  it('columns follow the Status option order; snapshot in metadata', () => {
    const snap = toSnapshot([withStatus('A', 'Done', Y, { assignees: ['carol'] }), withStatus('B', 'Todo', Y), item('C')], Y, ['Todo', 'Doing', 'Done']);
    const d = renderBoard(board, snap);
    const md = d.markdown!;
    expect(md.indexOf('## Todo')).toBeLessThan(md.indexOf('## Done'));
    expect(md.indexOf('## Done')).toBeLessThan(md.indexOf('## No status'));
    expect(md).not.toContain('## Doing');
    expect(md).toContain('@carol');
    expect(d.metadata.snapshot).toEqual(snap);
    expect(d.scopeRootId).toBe('project:acme/3');
    expect(d.createdAt).toBe(board.createdAt);
  });
});

describe('restoreBoardDays', () => {
  it('pages until a short page and keeps only this board', async () => {
    const rows: never[] = [];
    for (let i = 0; i < 700; i++) rows.push(<never>{ externalId: `acme/project/9:2026-09-${i}`, type: 'github.project_day', title: 't', markdown: 'm', metadata: {}, createdAt: Y });
    for (let i = 0; i < 400; i++) rows.push(<never>{ externalId: `acme/project/3:d${i}`, type: 'github.project_day', title: 't', markdown: 'm', metadata: { ledger: [] }, createdAt: Y });
    const offsets: number[] = [];
    const out = await restoreBoardDays(async (off) => (offsets.push(off), rows.slice(off, off + 500)), 'acme', 3);
    expect(offsets).toEqual([0, 500, 1000]);
    expect(out).toHaveLength(400);
    expect(out[0]).toMatchObject({ externalId: 'acme/project/3:d0', scopeRootId: 'project:acme/3', metadata: { ledger: [] } });
  });
});

describe('scanBoard', () => {
  it('a vanished board is NotFound, never an empty scan', async () => {
    const { client } = fakeGitHub([[/node\(id/, () => ({ data: { node: null }, errors: [{ type: 'NOT_FOUND', message: 'x' }] })]]);
    await expect(scanBoard(client, { id: 'P' } as never)).rejects.toBeInstanceOf(NotFoundError);
  });
});
