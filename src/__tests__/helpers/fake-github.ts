import { jsonRes } from '@kiagent/connector-sdk/testing';
import { GitHubClient } from '../../client';

export type Handler = (url: URL, body: { query?: string; variables?: Record<string, unknown> } | null) => unknown;

/** Routes by `METHOD path` regex (GraphQL: by a query substring via `gql`).
 *  A handler returning a HostResponse (has `status`) is passed through;
 *  anything else becomes 200 JSON. Unrouted requests throw. */
export function fakeGitHub(routes: [RegExp, Handler][]) {
  const calls: string[] = [];
  const fetch = async (raw: string, init?: { method?: string; body?: unknown }) => {
    const url = new URL(raw);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const key = `${init?.method ?? 'GET'} ${url.pathname}${body?.query ? ' ' + body.query.replace(/\s+/g, ' ') : ''}`;
    calls.push(key + url.search);
    for (const [re, h] of routes) {
      if (re.test(key)) {
        const out = h(url, body);
        return out && typeof out === 'object' && 'status' in (out as object) && 'body' in (out as object) ? (out as ReturnType<typeof jsonRes>) : jsonRes(200, out);
      }
    }
    throw new Error(`unrouted: ${key}`);
  };
  const client = new GitHubClient({ token: 't', fetch: fetch as never, sleep: async () => {} });
  return { client, calls, fetch };
}

export const commit = (sha: string, date: string, msg = `msg ${sha}`, login = 'alice') => ({
  sha,
  author: { login },
  commit: { message: msg, author: { name: login.toUpperCase(), email: `${login}@x.io`, date } },
});
