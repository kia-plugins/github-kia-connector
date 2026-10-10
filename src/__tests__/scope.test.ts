import { archiveSet, covers, expandFor, pickerSpec, type InvRepo } from '../scope';

const me = 'me';
const types: Record<string, 'User' | 'Organization'> = { 'X/a': 'Organization', 'X/b': 'Organization', 'bob/tool': 'User', 'me/dot': 'User' };
const typeOf = (f: string) => types[f];

describe('covers', () => {
  it.each([
    [[{ id: 'acct:me' }], 'repo:me/dot', true],
    [[{ id: 'acct:me' }], 'project:me/1', true],
    [[{ id: 'org:X' }], 'repo:X/a', true],
    [[{ id: 'org:X' }], 'project:X/2', true],
    [[{ id: 'projects:X' }], 'project:X/2', true],
    [[{ id: 'projects:X' }], 'repo:X/a', false],
    [[{ id: 'shared' }], 'repo:bob/tool', true],
    [[{ id: 'shared' }], 'repo:X/a', false],
    [[{ id: 'shared' }], 'repo:me/dot', false],
    [[{ id: 'repo:X/a' }], 'repo:X/a', true],
    [[{ id: 'repo:X/a' }], 'repo:X/b', false],
  ])('%j covers %s = %s', (roots, leaf, want) => expect(covers(roots, leaf, me, typeOf)).toBe(want));
});

describe('archiveSet', () => {
  it('untick org, tick one repo', () => {
    expect(archiveSet(['repo:X/a', 'repo:X/b', 'project:X/1'], [{ id: 'repo:X/a' }], me, typeOf).sort()).toEqual(['project:X/1', 'repo:X/b']);
  });
  it('archives an orphan the old roots never covered either', () => {
    expect(archiveSet(['repo:Y/z'], [{ id: 'org:X' }], me, typeOf)).toEqual(['repo:Y/z']);
  });
});

describe('picker', () => {
  const inv: InvRepo[] = [
    { full: 'X/b', owner: 'X', ownerType: 'Organization', pushedAt: '2026-10-09', defaultBranch: 'main', archived: false },
    { full: 'X/a', owner: 'X', ownerType: 'Organization', pushedAt: '2026-10-01', defaultBranch: 'main', archived: false },
    { full: 'bob/tool', owner: 'bob', ownerType: 'User', pushedAt: '2026-09-01', defaultBranch: 'main', archived: false },
  ];
  it('roots: account, orgs from inventory, shared', async () => {
    const s = pickerSpec({ c: {} as never, me, inv, purpose: 'connect' });
    expect((await s.roots('repos')).map((n) => n.id)).toEqual(['acct:me', 'org:X', 'shared']);
    expect((await s.children('org:X')).map((n) => n.id)).toEqual(['projects:X', 'repo:X/b', 'repo:X/a']);
  });
  it('no shared root without other-user repos', async () => {
    const s = pickerSpec({ c: {} as never, me, inv: inv.slice(0, 2), purpose: 'connect' });
    expect((await s.roots('repos')).map((n) => n.id)).toEqual(['acct:me', 'org:X']);
  });
  it('expand covers ancestors only', () => {
    expect(expandFor([{ id: 'project:X/3' }], me, typeOf)).toEqual(['org:X', 'projects:X']);
    expect(expandFor([{ id: 'repo:bob/tool' }, { id: 'org:X' }], me, typeOf)).toEqual(['shared']);
  });
});
