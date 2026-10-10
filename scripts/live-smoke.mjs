// Live smoke: runs the BUILT bundle against real GitHub with a token.
//   npm run build && GH_TOKEN=$(gh auth token) node scripts/live-smoke.mjs [rootId ...]
// Two passes: the second must report 0 changed docs (identical markdown+metadata).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mod = require('../dist/index.js');

const token = process.env.GH_TOKEN;
if (!token) throw new Error('set GH_TOKEN');
const roots = (process.argv.slice(2).length ? process.argv.slice(2) : ['repo:edjafarov/kiagent-core', 'repo:edjafarov/alpha-cent', 'projects:edjafarov']).map((id) => ({ id, name: id }));

const store = new Map();
const key = (id, t) => `${t}|${id}`;
const host = {
  self: { id: 'github', dataDir: '/tmp' },
  log: (l, m) => console.log(`[host ${l}] ${m}`),
  net: {
    async fetch(url, init = {}) {
      const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal });
      const headers = {};
      r.headers.forEach((v, k) => (headers[k] = v));
      return { status: r.status, statusText: r.statusText, headers, body: new Uint8Array(await r.arrayBuffer()) };
    },
  },
  query: {
    byExternalId: async (_a, id, t) => store.get(key(id, t)) ?? null,
    search: async (q) => [...store.values()].filter((d) => !q.type || d.type === q.type).slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 50)),
  },
};

const { sources } = await mod.activate(host);
const src = sources[0];
const me = await (await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}` } })).json();
const config = { login: me.login, userId: me.id, folderRoots: roots, backfillDays: 7 };

async function pass(cursor) {
  let changed = 0;
  let out = cursor;
  const counts = {};
  const t0 = Date.now();
  const session = {
    account: { id: 'acc', identifier: me.login, config, cursor },
    signal: new AbortController().signal,
    credentials: async () => ({ password: token }),
    log: (l, m) => console.log(`[${l}] ${m}`),
  };
  for await (const b of src.pull(session, cursor)) {
    for (const it of b.items) {
      for (const d of [].concat(src.toDocument(it))) {
        counts[d.type] = (counts[d.type] ?? 0) + 1;
        const prev = store.get(key(d.externalId, d.type));
        if (!prev || prev.markdown !== d.markdown || JSON.stringify(prev.metadata) !== JSON.stringify(d.metadata)) changed++;
        store.set(key(d.externalId, d.type), d);
      }
    }
    out = b.cursor;
  }
  return { cursor: out, changed, counts, ms: Date.now() - t0 };
}

const p1 = await pass(null);
console.log('pass 1:', p1.counts, `changed=${p1.changed}`, `${p1.ms}ms`);
const yesterday = new Date(Date.now() - 864e5).toLocaleDateString('en-CA', { timeZone: p1.cursor.tz });
for (const d of store.values()) {
  if (d.type === 'github.day' && d.externalId.endsWith(':' + yesterday)) {
    console.log('\n----- ' + d.externalId + '\n' + d.markdown.slice(0, 1500));
    break;
  }
}
const board = [...store.values()].find((d) => d.type === 'github.project');
if (board) console.log('\n----- ' + board.externalId + '\n' + board.markdown.slice(0, 800));
const p2 = await pass(p1.cursor);
console.log('\npass 2:', p2.counts, `changed=${p2.changed}`, `${p2.ms}ms`);
if (p2.changed !== 0) {
  console.error('FAIL: second pass changed docs');
  process.exit(1);
}
console.log('OK');
