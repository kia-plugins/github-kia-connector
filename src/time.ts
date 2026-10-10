/** Local-day helpers. Every day doc is keyed by the local day of the
 *  account's pinned zone (`cursor.tz`), never UTC. */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function local(ms: number, tz: string) {
  const o: Record<string, number> = {};
  for (const p of parts(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') o[p.type] = Number(p.value);
  }
  return o as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD of `iso` in `tz`. */
export function dayKey(iso: string, tz: string): string {
  const l = local(Date.parse(iso), tz);
  return `${l.year}-${pad(l.month)}-${pad(l.day)}`;
}

/** HH:MM of `iso` in `tz`. */
export function hhmm(iso: string, tz: string): string {
  const l = local(Date.parse(iso), tz);
  return `${pad(l.hour)}:${pad(l.minute)}`;
}

/** Offset (ms) of `tz` at instant `ms`: local wall clock − UTC. */
function offsetAt(ms: number, tz: string): number {
  const l = local(ms, tz);
  return Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second) - Math.floor(ms / 1000) * 1000;
}

/** UTC ISO of local midnight starting `day` in `tz` (DST-safe). */
export function dayStartIso(day: string, tz: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  let t = wall - offsetAt(wall, tz);
  // Re-check once: the offset at the guess may differ from the offset at
  // the true instant when a DST switch sits between them.
  t = wall - offsetAt(t, tz);
  return new Date(t).toISOString();
}
