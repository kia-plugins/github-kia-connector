import { dayKey, dayStartIso, hhmm } from '../time';
import { actorOf, coAuthors, participantsOf, primaryActor } from '../people';

describe('time', () => {
  it('dayKey uses the zone', () => {
    expect(dayKey('2026-10-08T22:30:00Z', 'Europe/Berlin')).toBe('2026-10-09');
    expect(dayKey('2026-10-08T21:30:00Z', 'Europe/Berlin')).toBe('2026-10-08');
  });
  it('dayStartIso is local midnight as UTC ISO, across DST', () => {
    expect(dayStartIso('2026-10-09', 'Europe/Berlin')).toBe('2026-10-08T22:00:00.000Z');
    expect(dayStartIso('2026-10-25', 'Europe/Berlin')).toBe('2026-10-24T22:00:00.000Z'); // switch day: midnight still CEST
    expect(dayStartIso('2026-10-26', 'Europe/Berlin')).toBe('2026-10-25T23:00:00.000Z');
    expect(dayStartIso('2026-03-29', 'Europe/Berlin')).toBe('2026-03-28T23:00:00.000Z');
    expect(dayStartIso('2026-10-09', 'America/Los_Angeles')).toBe('2026-10-09T07:00:00.000Z');
    expect(dayStartIso('2026-10-09', 'UTC')).toBe('2026-10-09T00:00:00.000Z');
  });
  it('hhmm', () => expect(hhmm('2026-10-08T07:14:00Z', 'Europe/Berlin')).toBe('09:14'));
});

describe('people', () => {
  it('actor strings', () => {
    expect(actorOf({ login: 'alice', name: 'Alice A' })).toBe('Alice A <alice>');
    expect(actorOf({ name: 'Bob', email: 'bob@x.io' })).toBe('Bob <bob@x.io>');
    expect(actorOf({ login: 'carol' })).toBe('carol');
    expect(actorOf({})).toBe('Unknown');
  });
  const e = (actor: string, emails?: string[]) => ({ id: actor + Math.random(), at: '', actor, text: '', emails });
  it('primaryActor = most entries, first on tie', () => {
    expect(primaryActor([e('a'), e('b'), e('b')])).toBe('b');
    expect(primaryActor([e('a'), e('b')])).toBe('a');
  });
  it('participants include emails, not Unknown', () => {
    expect(participantsOf([e('A <a>', ['a@x.io', 'bob@x.io']), e('Unknown')])).toEqual(['A <a>', 'a@x.io', 'bob@x.io']);
  });
  it('coAuthors parses trailers', () => {
    expect(coAuthors('fix\n\nCo-authored-by: Bob B <bob@x.io>\nco-authored-by: Eve <e@y.io>')).toEqual([
      { name: 'Bob B', email: 'bob@x.io' },
      { name: 'Eve', email: 'e@y.io' },
    ]);
  });
});
