import type { Entry } from './types';

export interface Actorish {
  login?: string | null;
  name?: string | null;
  email?: string | null;
}

/** "Name <login>", else "Name <email>", else login, else "Unknown". */
export function actorOf(u: Actorish | null | undefined): string {
  const name = u?.name?.trim();
  const login = u?.login?.trim();
  const email = u?.email?.trim();
  if (name && login) return `${name} <${login}>`;
  if (login) return login;
  if (name && email) return `${name} <${email}>`;
  return name || email || 'Unknown';
}

/** Actor with the most entries; ties go to the first seen. */
export function primaryActor(entries: Entry[]): string {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.actor, (counts.get(e.actor) ?? 0) + 1);
  let best = 'Unknown';
  let n = 0;
  for (const [a, c] of counts) {
    if (c > n) {
      best = a;
      n = c;
    }
  }
  return best;
}

/** Every actor plus every email, deduped, "Unknown" dropped. */
export function participantsOf(entries: Entry[]): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    if (e.actor !== 'Unknown') out.add(e.actor);
    for (const m of e.emails ?? []) if (m) out.add(m);
  }
  return [...out];
}

const CO_AUTHOR = /^co-authored-by:\s*(.+?)\s*<([^>]+)>\s*$/gim;

/** Co-author trailers of a commit message. */
export function coAuthors(message: string): { name: string; email: string }[] {
  const out: { name: string; email: string }[] = [];
  for (const m of message.matchAll(CO_AUTHOR)) out.push({ name: m[1], email: m[2] });
  return out;
}
