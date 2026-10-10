import type { DocumentInput } from '@kiagent/connector-sdk';

export const DOC = {
  day: 'github.day',
  pr: 'github.pr',
  issue: 'github.issue',
  project: 'github.project',
  projectDay: 'github.project_day',
} as const;

export const SCOPES = ['repo', 'read:org', 'read:user', 'user:email', 'read:project'];

export interface RepoState {
  ownerType: 'User' | 'Organization';
  /** ISO — nothing older is ingested for this repo. */
  horizon: string;
  /** Inventory `pushed_at` seen at the last commits stage ('' = never). */
  pushedAt: string;
  branchHeads: Record<string, string>;
  /** ISO watermark for touched issues/PRs. */
  itemsSyncedTo: string;
}

export interface ProjectState {
  horizon: string;
  /** Board `updatedAt` at the last scan ('' = never scanned). */
  updatedAt: string;
}

export interface Cursor {
  v: 1;
  phase: 'backfill' | 'live';
  tz: string;
  /** key "owner/name" */
  repos: Record<string, RepoState>;
  /** key "owner/number" */
  projects: Record<string, ProjectState>;
  /** owner → SSO authorize url (403 SSO only). */
  orgsBlocked?: Record<string, { url?: string }>;
  projectsUnavailable?: boolean;
}

/** A type alias (not an interface) so it gets the implicit index signature
 *  `Account.config: Record<string, unknown>` requires. */
export type Config = {
  login: string;
  userId: number;
  folderRoots: { id: string; name: string }[];
  backfillDays: 7 | 30 | 90 | 365;
};

/** One day-ledger entry. `id` is the dedupe key (spec §6.3). */
export interface Entry {
  id: string;
  at: string;
  /** "Name <login>" | "Name <email>" | login | "Unknown" */
  actor: string;
  /** commit author + co-author emails (→ metadata.participants) */
  emails?: string[];
  /** one markdown line, without the time prefix */
  text: string;
  /** optional indented continuation (rest of a commit message) */
  detail?: string;
}

/** Pull yields finished documents; toDocument is the identity. */
export type Item = DocumentInput;
