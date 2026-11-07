import test from 'node:test';
import assert from 'node:assert/strict';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';

interface OwnedMachine {
  name: string;
  owner: string;
  handles: RegExp;
  writes: RegExp[];
  allowedOffenders: Map<string, string>;
}

const MACHINES: OwnedMachine[] = [
  {
    name: 'merge status',
    owner: 'session/core/worktree-state.ts',
    handles: /\bmergeStatus\b/,
    writes: [/\.mergeStatus\s*=[^=]/, /\bObject\.assign\([^)]*mergeStatus/, /\bmergeStatus\s*:\s*["'`]/],
    allowedOffenders: new Map([
      ['session/session-worktree-lifecycle.ts', 'seeds the initial none status and applies the owner verdict from nextMergeState'],
    ]),
  },
  {
    name: 'team review draft',
    owner: 'server/github/core/team-review-core.ts',
    handles: /\b(?:ReviewDraft|TeamReviewStateEntry)\b/,
    writes: [/\bstatus\s*:\s*["'`](?:ready|stale|posted|discarded|error)["'`]/],
    allowedOffenders: new Map([
      ['server/github/team-review-actions.ts', 'markDraft patches draft status directly until the team review slice'],
      ['server/github/team-review-poller/team-review-operator-actions.ts', 'requeue, restore and not-mine spread draft status directly until the team review slice'],
      ['server/github/team-review-poller/team-review-runs.ts', 'settleNotMineReview spreads draft status directly until the team review slice'],
      ['server/packs/core/pack-preview-core.ts', 'builds a sample ready draft for the pack preview, never a stored draft'],
    ]),
  },
  {
    name: 'pr action run',
    owner: 'server/github/core/pr-flows-core.ts',
    handles: /\bPrActionRun(?:Record|State)\b/,
    writes: [/\bstate\s*:\s*["'`](?:running|started|done|failed|refused|interrupted)["'`]/],
    allowedOffenders: new Map([
      ['server/github/pr-flows-wiring.ts', 'builds running runs and checks running alone for liveness until the pr action slice'],
    ]),
  },
  {
    name: 'community run',
    owner: 'server/community/core/community-core.ts',
    handles: /\bCommunityStateEntry\b|community-core\.ts/,
    writes: [/\bstatus\s*:\s*["'`](?:queued|running|ready|error|aside)["'`]/, /\.status\s*!==?\s*["'`]running["'`]/],
    allowedOffenders: new Map(),
  },
  {
    name: 'session teardown',
    owner: 'session/core/session-teardown.ts',
    handles: /\bclass Session\b/,
    writes: [/\b_(?:pendingRestart|finishing|ptyAlive)\b/, /\.once\(\s*["']exit["']/],
    allowedOffenders: new Map([
      ['session/sessions.ts', 'teardown runs on _pendingRestart, _finishing, _ptyAlive and once(exit) closures until the session teardown slice'],
    ]),
  },
];

const MACHINE_WRITER_SOURCE = /^(?:server|session|mcp|cloud|detection|notifications)\/(?!.*\.test\.ts$).*\.ts$/;

const STATUS_FIELD_AS_FREE_STRING = /["'`]?\b(status|state|phase|mode|\w+Status|\w+State)["'`]?\s*:\s*z\s*\.\s*(?:coerce\s*\.\s*)?string\s*\(/g;

const ALLOWED_FREE_STRING_STATUS_FIELDS = new Map<string, { count: number; reason: string }>([
  ['shared/contracts/control/worktree-messages.ts#state', { count: 1, reason: 'branch sync verdict from decideBranchSyncState, not yet a contract enum' }],
  ['shared/contracts/my-prs.ts#state', { count: 5, reason: 'GitHub GraphQL review and status states, an external vocabulary that grows without notice' }],
  ['shared/contracts/my-prs.ts#mergeStateStatus', { count: 2, reason: 'GitHub GraphQL mergeStateStatus, an external vocabulary' }],
  ['shared/contracts/my-prs.ts#status', { count: 1, reason: 'GitHub GraphQL CheckRun status, an external vocabulary' }],
  ['shared/contracts/session.ts#state', { count: 1, reason: 'Coder workspace state reported by the external Coder CLI' }],
  ['shared/contracts/pr-flows.ts#state', { count: 1, reason: 'operator-authored commit status state line, free text by design' }],
  ['shared/contracts/pack-bridge.ts#state', { count: 1, reason: 'pack bridge mirrors session STATES in its describe text for third-party packs' }],
]);

function trackedSourceFiles(): string[] {
  return trackedFiles(/^(?!.*\.test\.ts$).*\.ts$/);
}

test('a registered state machine is written only by its owner module', () => {
  const sourceFiles = trackedFiles(MACHINE_WRITER_SOURCE);
  assert.ok(sourceFiles.length > 300, `expected to scan the source tree, only found ${sourceFiles.length} files`);
  const failures: string[] = [];
  for (const machine of MACHINES) {
    const writingFiles = sourceFiles
      .filter((repoPath) => repoPath !== machine.owner)
      .filter((repoPath) => {
        const sourceText = readTracked(repoPath);
        return machine.handles.test(sourceText) && machine.writes.some((pattern) => pattern.test(sourceText));
      });
    for (const repoPath of writingFiles) {
      if (!machine.allowedOffenders.has(repoPath)) failures.push(`${repoPath} writes the ${machine.name} machine, which only ${machine.owner} may change`);
    }
    for (const allowedPath of machine.allowedOffenders.keys()) {
      if (!writingFiles.includes(allowedPath)) failures.push(`${allowedPath} no longer writes the ${machine.name} machine: delete its allowedOffenders entry`);
    }
  }
  assert.deepEqual(failures, []);
});

test('a status-like field in a wire or persisted contract is a z.enum, not a free string', () => {
  const contractFiles = trackedSourceFiles().filter((repoPath) => repoPath.startsWith('shared/contracts/'));
  const countByFileField = new Map<string, number>();
  for (const repoPath of contractFiles) {
    for (const match of readTracked(repoPath).matchAll(STATUS_FIELD_AS_FREE_STRING)) {
      const fileField = `${repoPath}#${match[1]}`;
      countByFileField.set(fileField, (countByFileField.get(fileField) ?? 0) + 1);
    }
  }
  const failures: string[] = [];
  for (const [fileField, count] of countByFileField) {
    const allowed = ALLOWED_FREE_STRING_STATUS_FIELDS.get(fileField);
    if (!allowed) failures.push(`${fileField} is z.string(); declare its states with z.enum`);
    if (allowed && count > allowed.count) failures.push(`${fileField} has ${count} free string fields, ${allowed.count} allowed`);
  }
  for (const [fileField, allowed] of ALLOWED_FREE_STRING_STATUS_FIELDS) {
    const count = countByFileField.get(fileField) ?? 0;
    if (count < allowed.count) failures.push(`${fileField} now has ${count} free string fields: lower its allowed count from ${allowed.count}`);
  }
  assert.deepEqual(failures, []);
});
