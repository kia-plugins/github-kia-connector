# GitHub connector for KIAgent

Indexes your GitHub activity so Kia can answer "what did I (or a teammate) do yesterday?".

## What is indexed

- **Commits**: message plus metadata (sha, branch, author, co-authors, time), on every active
  branch. **Never code**: no diffs, file contents or file paths.
- **Pull requests and issues**: one document each, with description, state, labels,
  assignees, reviews, review comments and comments, as a timeline.
- **Releases**: published releases.
- **Project boards (Projects v2)**: one document per board, showing its current columns.
  Each board also gets a per-day document of moves, adds, clears and removals.

Commits, PR/issue events and releases are also summarised as one **day document per
repository per local day** (`github.day`), grouped by person.

## Signing in

- **Sign in with GitHub**: leave the token field empty. Kia asks for `repo read:org
  read:user user:email read:project`.
- **Or a classic personal access token** with the same scopes. Fine-grained tokens work for
  the repositories they grant.

To switch between the two methods later, use **Reconnect**.

Organizations with SAML SSO must authorize Kia (or your token). The connector logs an
"Authorize Kia for <org>" link and keeps syncing your other organizations.

## Choosing what to index

The picker lists your account, your organizations, and repositories shared with you. You can
tick a whole account or organization, a single repository, or individual boards under
**Projects**. Unticking something later removes its documents from Kia.

When you connect, you choose how much history to import: 7, 30, 90 or 365 days (default 30).

## Development

```bash
npm install
npm run typecheck && npx jest --runInBand      # includes the bundle smoke (builds dist/)
npm run build && GH_TOKEN=$(gh auth token) node scripts/live-smoke.mjs   # live, read-only
```

The live smoke needs a token with `read:project` to see boards
(`gh auth refresh -s read:project`). Its second pass must report `changed=0`.

Requires KIAgent platform API ^2.10.0, which adds the core `github` OAuth provider.
