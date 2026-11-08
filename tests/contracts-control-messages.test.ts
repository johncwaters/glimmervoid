import { myPrsStatus } from '../server/github/core/my-prs-core.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from 'zod';

import { ClientMessage, ServerMessage } from '../shared/contracts/index.ts';
import {
  type ServerMessageOf,
  CONTROL_FRAME_MAX_BYTES,
} from '../shared/contracts/control-messages.ts';
import { Session } from '../session/sessions.ts';
import { MyPr, MyPrsStatus } from '../shared/contracts/my-prs.ts';
import {
  PLAN_BODY_CAP_BYTES,
  PLAN_COMMENTS_MAX,
  PLAN_COMMENT_MAX_CHARS,
  PLAN_FEEDBACK_MAX_CHARS,
  PlanDecision,
} from '../shared/contracts/plan-review.ts';
import { STATES } from '../shared/states.ts';
import { REFRESHABLE_TYPES } from '../server/core/control-send-core.ts';
import { connectControl, controlDeps, createControlServer } from './helpers/control-harness.ts';

interface ServerPayload {
  type: string;
  [field: string]: unknown;
}

function schemaTypes(schema: typeof ClientMessage | typeof ServerMessage): Set<string> {
  return new Set(schema.options.map((option) => option.shape.type.value));
}

const NOW = 1_777_000_000_000;
const UPDATE_JOURNAL = {
  state: 'staged' as const,
  fromSha: '1111111111111111111111111111111111111111',
  toSha: '0123456789abcdef0123456789abcdef01234567',
  toVersion: '0.24.0',
  channel: 'release' as const,
  steps: [{
    id: 'fetch' as const,
    status: 'succeeded' as const,
    startedAt: NOW,
    finishedAt: NOW + 1,
    outputTail: [],
  }],
  activeStep: null,
  reason: null,
  startedAt: NOW,
  finishedAt: NOW + 2,
};
const PLAN_REVIEW = {
  agentId: 'agent-9',
  agentType: 'general-purpose',
  revisions: [{ revision: 1, receivedAt: NOW, chars: 6271, title: 'First cut' }],
  state: 'decided' as const,
  openRevision: null,
  approvedRevision: 1,
  lastDecision: 'approve' as const,
};
const SESSION = {
  id: 'session-1',
  name: 'glimmervoid',
  path: '/repo/glimmervoid',
  agent: 'claude-code',
  state: STATES.RUNNING,
  stateSince: NOW,
  taskTitle: null,
  taskTitleIsCustom: false,
  dangerouslySkipPermissions: true,
  saneYolo: true,
  ephemeral: false,
  isWorktree: true, isWorkspace: false, remoteWorkspace: 'gv-dev-1',
  resumeSessionId: null,
  activeAgents: 0,
  awaitingBackgroundTasks: false,
  pendingPromptKind: null,
  hasPlan: false,
  mergeStatus: 'none',
  mergeReason: null,
  worktreeNotice: null,
  unseenOutcome: null,
  managerSeenSeq: 0,
  isQuestionManagerOn: true,
  effectiveBase: 'develop',
  linkedPrs: [{ repo: 'acme/app', number: 42, url: 'https://github.com/acme/app/pull/42', source: 'hook', linkedAt: NOW }],
  coherenceHooks: { active: false, reason: 'not installed' },
  attentionNotes: [{ origin: 'coherence-verdict', note: 'Coherence invariant server/lane/lane boundary still fails after the agent\'s turn', at: NOW }],
  auditLog: [],
};

const REAL_SERVER_PAYLOADS: ServerPayload[] = [
  { type: 'snapshot', sessions: [SESSION], serverBuild: 'build-1' },
  { type: 'session-status', id: 'session-1', session: 'glimmervoid', timestamp: NOW, transition: { from: STATES.IDLE, to: STATES.RUNNING, event: 'user_input' }, skipPerms: true, saneYolo: false, activeAgents: 2, awaitingBackgroundTasks: true, unseenOutcome: 'failed', pendingPromptKind: 'permission' },
  { type: 'session-added', id: 'session-1', session: 'glimmervoid', path: '/repo/glimmervoid', agent: 'claude-code', state: STATES.DORMANT, stateSince: NOW, skipPerms: true, saneYolo: true, worktree: false, resumeSessionId: null },
  { type: 'session-removed', id: 'session-1', session: 'glimmervoid' },
  { type: 'session-close-confirm', id: 'session-1', mergeStatus: 'pending-review' },
  { type: 'session-renamed', id: 'session-1', oldName: 'old', newName: 'glimmervoid' },
  { type: 'session-secret-request', id: 'session-1', names: ['OPENAI_API_KEY'], newItemsVault: 'Dev' },
  { type: 'secret-requests-snapshot', requests: { 'session-1': ['OPENAI_API_KEY'] }, newItemsVault: null },
  { type: 'secret-approvals', projects: [{ project: '/repo/glimmervoid', approvals: [{ name: 'OPENAI_API_KEY', reference: 'op://dev/openai/credential', isAllowed: true }] }] },
  { type: 'session-title', id: 'session-1', taskTitle: 'Fix dashboard', isCustom: false },
  { type: 'session-prs', id: 'session-1', linkedPrs: [{ repo: 'PostHog/glimmervoid', number: 42, url: 'https://github.com/PostHog/glimmervoid/pull/42', source: 'hook', linkedAt: NOW }] },
  { type: 'session-modified', id: 'session-1', session: 'glimmervoid', path: '/repo/glimmervoid', agent: 'claude-code', state: STATES.DORMANT, stateSince: NOW, skipPerms: true, saneYolo: true, worktree: false, resumeSessionId: null },
  { type: 'session-git', id: 'session-1', worktree: true },
  { type: 'session-coherence-hooks', id: 'session-1', coherenceHooks: { active: false, reason: 'check failed with exit code 1' } },
  { type: 'session-manager-decision', id: 'session-1', decision: { kind: 'question-manager', seq: 1, ts: 1, outcome: 'escalated', questions: ['Delete the old exporter?'], reason: 'the question names a risk word: delete' } },
  { type: 'session-status', id: 'session-1', session: 'glimmervoid', timestamp: NOW, unseenOutcome: null },
  { type: 'session-merge-status', id: 'session-1', session: 'glimmervoid', mergeStatus: 'pending-review', reason: null, parked: false, timestamp: NOW },
  { type: 'session-worktree-blocked', id: 'session-1', session: 'glimmervoid', branch: 'develop', notice: 'missing branch', timestamp: NOW },
  { type: 'session-worktree-ready', id: 'session-1', session: 'glimmervoid', branch: 'glimmervoid/session/1', base: 'develop', timestamp: NOW },
  { type: 'session-diff', id: 'session-1', committed: { stat: '1 file', diff: 'patch' }, uncommitted: { stat: '', diff: '' }, hasCommits: true, bases: [{ member: null, ref: 'origin/main', sha: 'db44dc0c', verified: true }] },
  { type: 'session-diff-error', id: 'session-1', message: 'git diff HEAD timed out after 15000ms' },
  { type: 'change-map', id: 'session-1', map: { sessionId: 'session-1', sig: 'sig-1', generatedAt: NOW, repos: [] } },
  { type: 'branch-sync-status', id: 'session-1', branch: 'develop', upstream: 'origin/develop', state: 'ahead', ahead: 1, behind: 0, fetched: true },
  { type: 'session-changed', id: 'session-1', sig: 'sha' },
  { type: 'debug-state-response', id: 'session-1', payload: { state: STATES.RUNNING } },
  { type: 'session-trace-response', id: 'session-1', records: [], start: 0, next: 0, reset: false, path: '/traces/session-1.jsonl' },
  { type: 'session-trace-changed', id: 'session-1' },
  { type: 'session-plan-changed', id: 'session-1', agentId: null, agentType: null, revision: 2, receivedAt: NOW, state: 'open', lastDecision: null, approvedRevision: null, chars: 8454, title: 'Shrink the large owned files', hasPlan: true },
  { type: 'session-plan-draft', id: 'session-1', agentId: null, planFilePath: '/home/u/.claude/plans/a.md', changedAt: NOW },
  { type: 'session-plan-response', id: 'session-1', reviews: [PLAN_REVIEW], body: { agentId: 'agent-9', revision: 2, plan: '# Shrink the large owned files', planFilePath: '/home/u/.claude/plans/a.md', receivedAt: NOW } },
  { type: 'session-docs-changed', id: 'session-1', docs: [{ path: '/repo/drafts/post.md', name: 'drafts/post.md', surfacedAt: NOW }] },
  { type: 'session-docs-snapshot', sessions: { 'session-1': [{ path: '/repo/drafts/post.md', name: 'drafts/post.md', surfacedAt: NOW }] } },
  { type: 'session-doc-response', requestId: 'session-doc-read-1', id: 'session-1', path: '/repo/drafts/post.md', ok: true, text: '# Draft', hash: 'abc' },
  { type: 'session-doc-asset-response', requestId: 'session-doc-asset-read-1', id: 'session-1', path: '/repo/drafts/post.md', src: 'img/chart.png', ok: true, mime: 'image/png', base64: 'iVBORw0K' },
  { type: 'session-doc-save-result', requestId: 'session-doc-save-1', id: 'session-1', path: '/repo/drafts/post.md', ok: false, conflict: true, error: 'the file changed on disk since it was opened, so reload it before saving' },
  {
    type: 'session-coherence', id: 'session-1', updatedAt: NOW,
    journal: { ok: true, latest: { id: 'd-f16808ad', at: '2026-10-17T10:00:00.000Z', kind: 'decision', text: 'use plain files', detail: 'simplest', supersedes: null } },
  },
  { type: 'session-coherence-snapshot', sessions: { 'session-1': { journal: { ok: false, reason: 'the Coherence journal is not a regular file' }, updatedAt: NOW } } },
  { type: 'session-coherence-journal-response', requestId: 'r-journal', id: 'session-1', ok: true, entries: [{ id: 'def-0123456789ab', at: '2026-10-17T10:05:00.000Z', kind: 'defect', text: 'flaky socket test', detail: null, supersedes: null }] },
  { type: 'session-setup-response', requestId: 'r-setup', id: 'session-1', ok: true, setup: { model: null, mcpServers: [], plugins: [], skills: [], agents: [], hookEvents: [], hookCommands: [] } },
  { type: 'notify', session: 'session-1', category: 'complete', message: 'finished', escalationCount: 0 },
  {
    type: 'update-status', updateAvailable: true, current: '0.23.1', latest: '0.24.0', currentSha: null,
    latestSha: '0123456789abcdef0123456789abcdef01234567', releaseUrl: 'https://example.test/release',
    command: 'npm install', flavor: 'npm-global', platform: 'linux', installedBranch: null, upstream: null, isTreeClean: null,
    lastCheckAt: NOW, channel: 'release', reason: null, deprecation: 'Versions below 0.24.0 are unsafe.',
    journalSummary: { state: 'staged', activeStep: null, reason: null, startedAt: NOW, finishedAt: NOW + 2 },
    applyRefusal: { reason: 'already-staged', message: 'Restart to apply the staged update.' },
  },
  { type: 'update-progress', journal: UPDATE_JOURNAL },
  { type: 'post-turn-leftovers', repositories: ['/repos/one'], command: "git -C '/repos/one' rm --cached -q -- '.glimmervoid/post-turn/one.json'" },
  { type: 'post-turn-leftovers', repositories: [], command: '' },
  { type: 'error', message: 'refused' },
  { type: 'session-error', id: 'session-1', session: 'glimmervoid', message: 'failed' },
  { type: 'settings', requestId: 'settings-1', settings: { cursorBlink: false } },
  { type: 'settings-error', requestId: 'settings-1', message: 'invalid' },
  { type: 'settings-updated', requestId: 'settings-1', settings: { cursorBlink: true } },
  { type: 'telegram-test-result', requestId: 'telegram-test-1', ok: false, error: 'Telegram answered 401: Unauthorized', telegramDelivery: { setupWarning: null, lastFailure: { message: 'Telegram answered 401: Unauthorized', failedAt: NOW } } },
  { type: 'telegram-test-result', requestId: 'telegram-test-2', ok: false, error: 'Telegram is not running on this server.', telegramDelivery: null },
  { type: 'pong', requestId: 'ping-1' },
  { type: 'agent-logins', requestId: 'logins-1', logins: [{ agent: 'codex', state: 'connecting', source: null, verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'WXYZ-12345', needsPastedCode: false, reason: null }] },
  { type: 'agents-listed', requestId: 'agents-1', agents: [{ id: 'claude-code', label: 'Claude Code', resolvable: true }] },
  { type: 'github-teams-listed', requestId: 'teams-1', viewer: 'octocat', teams: [{ org: 'PostHog', slug: 'team-devex', name: 'DevEx' }], orgs: ['PostHog'], error: null },
  { type: 'repo-roots-scanned', requestId: 'roots-1', directories: [{ root: '/repo', projects: [{ name: 'glimmervoid', path: '/repo/glimmervoid' }] }] },
  { type: 'conversations', requestId: 'conversations-1', id: 'session-1', current: null, conversations: [{
    id: 'conversation-1',
    title: 'Fix contracts',
    cwd: '/repo/glimmervoid',
    worktreePath: '/repo/glimmervoid',
    worktreeName: 'glimmervoid',
    gitBranch: 'refs/heads/feat/typed-contracts',
    mtime: NOW,
  }] },
  { type: 'resume-conversation-ack', id: 'session-1', resumeSessionId: 'conversation-1', ok: true },
  { type: 'health-snapshot', stats: { process: {}, sessions: {}, websockets: {} } },
  { type: 'radar-status', ts: NOW, intervalMinutes: 15, projects: [], investigations: [] },
  { type: 'radar-investigation-activity', projectId: 7, issueId: 'issue-1', inFlight: true, startedAt: NOW, trail: [{ at: NOW, tool: 'Read', detail: 'server/a.ts' }] },
  { type: 'radar-investigation-finished', projectId: 7, issueId: 'issue-1', verdict: 'NEEDS_HUMAN', summaryLine: 'the retry path double-fires', startedAt: NOW, trail: [{ at: NOW, tool: 'Read', detail: 'server/a.ts' }] },
  { type: 'radar-report', requestId: 'posthog-1', ok: true, found: true, issueId: 'issue-1', format: 'markdown', content: 'report' },
  { type: 'radar-open-session-result', requestId: 'posthog-2', ok: true, error: null, sessionId: 'session-1' },
  { type: 'issues-status', ts: NOW, configured: true, reason: null, lastSyncAt: NOW, issues: [{ key: 'acme/repo#42', repo: 'acme/repo', number: 42, title: 'Reconnect drops queued writes', labels: ['bug'], assignees: ['alice'], author: 'bob', isAuthorOrgMember: true, comments: 1, url: 'https://github.com/acme/repo/issues/42', createdAt: '2026-09-13T10:00:00Z', updatedAt: '2026-09-13T10:00:00Z', sources: ['project', 'me'], teams: [], projectId: 'p1', sessionId: null, pullRequests: [] }] },
  { type: 'issue-detail-result', requestId: 'detail-1', ok: true, body: '<b>plain text</b>', error: null },
  { type: 'set-issue-state-result', requestId: 'issues-3', ok: false, error: 'HTTP 403: Resource not accessible' },
  { type: 'open-issue-session-result', requestId: 'issues-2', ok: true, error: null, sessionId: 'session-2', sessionName: 'issue-42-fix-reconnect', pending: false },
  { type: 'open-team-review-session-result', requestId: 'team-review-2', ok: true, error: null, key: 'acme/app#7', sessionId: 'session-3', sessionName: 'pr-app-7-fix-login', pending: false, existing: false },
  { type: 'radar-issue-action-result', requestId: 'posthog-3', ok: true, error: null, status: 'resolved' },
  { type: 'telemetry-deletion-result', requestId: 'telemetry-1', ok: true },
  { type: 'team-review-action-result', requestId: 'review-1', key: 'PostHog/wizard#1350', ok: true },
  { type: 'community-action-result', requestId: 'community-1', key: 'forum:4', ok: false, error: 'The research run for this question is still going' },
  { type: 'open-community-session-result', requestId: 'community-2', ok: true, error: null, key: 'forum:4', sessionId: 'session-9', sessionName: 'Community: Send events from a server', pending: false },
  { type: 'community-status', ts: NOW, configured: true, intervalMinutes: 5, error: null, entries: [{
    item: { key: 'forum:4', source: 'forum', title: 'Send events from a server', body: 'How do I send events from a server?', url: 'https://posthog.com/forum/p/question-4', author: 'Asker', channel: 'ask-the-hogs', tags: ['API & SDKs'], createdAt: '2026-10-28T12:01:00Z' },
    status: 'ready', verdict: 'HIGH', summary: 'The docs answer it.', goal: 'Send events from a server', checked: ['the capture docs show the endpoint'], gaps: [],
    draft: { body: 'Use the capture endpoint.', publicLinks: ['https://posthog.com/docs'] }, attempts: 1, seenAt: '2026-10-28T12:05:00Z', finishedAt: '2026-10-28T12:06:00Z',
  }] },
  { type: 'github-polling-refresh-result', requestId: 'refresh-1', ok: true },
  { type: 'benchmark-action-result', requestId: 'bench-1', suiteId: 'review-ladder', action: 'run', ok: true, runId: 'run-1' },
  { type: 'benchmark-status', ts: NOW, configured: true, reason: null, suites: [{
    id: 'review-ladder', title: 'Review ladder', error: null, caseCount: 5, candidateCount: 2,
    armIds: ['baseline', 'candidate'], baselineArm: 'baseline', latestReport: null,
  }], inFlight: {
    suiteId: 'review-ladder', runId: 'run-1', caseId: '464', armId: 'candidate', trial: 1,
    phase: 'subject', cellIndex: 3, cellCount: 10, startedAt: NOW,
  } },
  { type: 'my-pr-merge-result', requestId: 'merge-1', key: 'PostHog/wizard#1350', ok: false, error: 'Checks are failing' },
  { type: 'my-pr-keep-mergeable-result', requestId: 'toggle-1', key: 'PostHog/wizard#1350', ok: true },
  { type: 'my-pr-merge-when-ready-result', requestId: 'queue-1', key: 'PostHog/wizard#1350', ok: true },
  { type: 'pr-flow-dispose-result', requestId: 'flow-1', ok: true },
  { type: 'pr-flows-status', handledByPr: { 'PostHog/wizard#1350': [{ itemKey: 'src/a.ts:10:PRRT_1', dismissalKeys: ['abc123'], action: 'dismiss', location: 'src/a.ts:10', reason: 'Validated upstream', at: NOW, ruleName: null, threadIds: ['PRRT_1'] }] }, warnings: [], pendingApprovals: [], sourceRunsByPr: {}, reviewItemsByPr: {}, actions: [], actionRunsByPr: {}, prActionsByPr: { 'PostHog/wizard#1350': [{ id: 'agent-merge', label: 'Merge via agent' }] }, prActionRunsByPr: { 'PostHog/wizard#1350': [{ actionId: 'agent-merge', label: 'Merge via agent', state: 'started', message: 'https://example.test/tasks/1' }] } },
  { type: 'radar-archive-investigation-result', requestId: 'posthog-4', ok: true, error: null },
  { type: 'radar-approve-fix-result', requestId: 'posthog-5', ok: true, error: null, sessionId: 'session-1', sessionName: 'Radar fix web #1' },
  { type: 'radar-dismiss-fix-result', requestId: 'posthog-6', ok: false, error: 'That investigation has no fix waiting for approval' },
  { type: 'team-review-status', ts: NOW, configured: true, drafts: [{
    key: 'PostHog/wizard#1350', repo: 'PostHog/wizard', number: 1350, title: 'Improve agent detection',
    url: 'https://github.com/PostHog/wizard/pull/1350', author: 'teammate', requestSource: 'team', tier: 'stamp', reasons: ['12 counted lines in 1 files'],
    reviewedHead: 'a'.repeat(40), verdict: 'APPROVE', summary: 'Looks right', body: 'Matches the description.',
    comments: [{ path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'Nit' }], status: 'ready',
  }], inFlight: [{
    key: 'PostHog/wizard#1351', repo: 'PostHog/wizard', number: 1351, title: 'Tighten retries',
    url: 'https://github.com/PostHog/wizard/pull/1351', author: 'teammate', requestSource: 'team', tier: 'full', reasons: ['touches auth'],
    head: 'b'.repeat(40), phase: 'reviewing', startedAt: NOW, deadlineAt: NOW + 900000, toolCalls: 2,
    recentSteps: [{ at: NOW, tool: 'Read', detail: 'src/retry.ts' }],
  }], queued: [{
    key: 'PostHog/wizard#1352', repo: 'PostHog/wizard', number: 1352, title: 'Move files',
    url: 'https://github.com/PostHog/wizard/pull/1352', author: 'teammate', requestSource: 'team',
  }] },
  { type: 'my-prs-status', ts: NOW, configured: true, viewer: 'alice', prs: [], error: null },
  { type: 'github-prs', ts: NOW, prs: {}, freshness: { lastRefreshedAt: null, error: null } },
  { type: 'usage-sessions', ts: NOW, pricingSource: 'bundled', sessions: [{ id: 'session-1', tokens: 123, costUSD: 0.5, officialCostUSD: null }] },
  { type: 'usage-report', requestId: 'usage-1', ts: NOW, tz: 'UTC', blockHours: 5, totals: {}, daily: [], models: [], sessions: [], blocks: [], activeBlock: null, anomaly: null, byLane: {}, budget: {}, savings: {}, pricing: {}, scan: {}, warning: null, error: null },
  { type: 'plan-limits', ts: NOW, fiveHour: { pct: 10, resetsAtMs: NOW + 1000 }, sevenDay: null, source: 'statusline' },
  { type: 'usage-budget-alert', scope: 'daily', periodKey: '2026-08-26', threshold: 50, spentUsd: 5, budgetUsd: 10, text: 'budget crossed', ts: NOW },
  { type: 'client-trust', trust: 'local' },
  { type: 'whiteboards-snapshot', boards: [{ id: 'board-1', title: 'Ingest plan', version: 3, updatedAt: NOW, project: null, isArchived: false, connectedSessionIds: ['session-1'], queuedBySessionId: { 'session-1': 2 } }] },
  { type: 'whiteboard-removed', boardId: 'board-1' },
  {
    type: 'whiteboard-tiles', boardId: 'board-1', version: 4, elementCount: 1,
    head: { id: 'board-1', title: 'Ingest plan', version: 4, caption: null, legend: [], codeSessionId: null, project: null, createdAt: NOW, updatedAt: NOW },
    chrome: { legend: [], caption: null, plan: null, pinnedOffsetY: 0, bounds: { x: 0, y: 0, width: 400, height: 300 } },
    tiles: [{ key: { chunkX: 0, chunkY: 0, lod: 'full', level: 0 }, elements: [{ paintOrder: 0, element: { kind: 'frame', id: 'frame-1', title: 'Ingest', isLoop: false, stackedBoxCount: null, x: 0, y: 0, width: 400, height: 300 } }], raster: null }],
  },
  {
    type: 'whiteboard-tile-diff', boardId: 'board-1', fromVersion: 4, toVersion: 5, elementCount: 0,
    head: { id: 'board-1', title: 'Ingest plan', version: 5, caption: null, legend: [], codeSessionId: null, project: null, createdAt: NOW, updatedAt: NOW },
    diff: { changed: [], removedIds: ['frame-1'], rasters: [], chrome: null },
  },
  {
    type: 'whiteboard-result', requestId: 'wb-1', ok: true, error: null,
    board: {
      id: 'board-1', title: 'Ingest plan', version: 1, caption: null, legend: [], codeSessionId: null, project: null,
      elements: { parse: { kind: 'box', id: 'parse', title: 'Parse feed', icon: null, lines: [], refs: [], change: 'none', was: null, near: null, order: 0, at: { x: 40, y: 40 }, shape: 'box', outputs: [], media: null, params: {}, width: null, height: null, step: null } },
      createdAt: NOW, updatedAt: NOW,
    },
    summary: { id: 'board-1', title: 'Ingest plan', version: 1, updatedAt: NOW, project: null, isArchived: false, connectedSessionIds: [], queuedBySessionId: {} },
    patch: {
      boardId: 'board-1', fromVersion: 0, toVersion: 1, author: { id: 'operator', name: 'operator' }, updatedAt: NOW,
      diff: { fields: { title: 'Ingest plan' }, elements: { parse: ['patch', { at: { x: 40, y: 40 } }], old: ['remove'] } },
      before: { fields: { title: 'Ingest' }, elements: { parse: { kind: 'box', id: 'parse', title: 'Parse feed', icon: null, lines: [], refs: [], change: 'none', was: null, near: null, order: 0, at: { x: 0, y: 0 }, shape: 'box', outputs: [], media: null, params: {}, width: null, height: null, step: null }, old: null } },
    },
  },
  { type: 'session-worktree-warning', id: 'session-1', session: 'Session 1', branch: 'glimmervoid/session/session-1', notice: 'offline', timestamp: NOW },
  { type: 'shutting-down' },
  { type: 'restarting' },
  {
    type: 'hooks-report', requestId: 'r1', ts: NOW,
    hooks: [{ id: 'h1', name: 'lint', event: 'PostToolUse', matcher: 'Edit', type: 'command', command: 'npm run lint', enabled: true }],
    builtinByAgent: [{ agentId: 'claude-code', label: 'Claude Code', isBestEffort: false, version: null, unavailableReason: null, rows: [{ event: 'Stop', matcher: null, purpose: 'Status detection: the turn finished' }] }],
    agentNotes: [{ name: 'Board changes', carriedBy: 'UserPromptSubmit', firesWhen: 'a connected board changed', text: 'Board "<title>" (<board id>) changed since your last read:', isTemplate: true }],
    events: [{ name: 'PostToolUse', matcher: 'tool name (regex)', description: 'After a tool succeeds.' }],
    projects: [{ id: 'p1', name: 'glimmervoid', agent: 'claude-code' }],
    limits: { maxTimeoutSec: 600 },
    error: null,
  },
  { type: 'save-hook-result', requestId: 'r2', ok: true, error: null, hook: { id: 'h1' } },
  { type: 'add-session-result', requestId: 'r6', ok: false, error: '/repos/notes is not a git repository', reason: 'not-git' },
  { type: 'start-remote-setup-result', requestId: 'r8', ok: true, error: null, sessionId: 'remote-setup-0b1c', sessionName: 'Remote host setup' },
  { type: 'host-change-result', requestId: 'r8h', ok: false, error: 'a host with id devbox is already registered' },
  { type: 'remove-session-result', requestId: 'r7', ok: false, error: 'Branch feature in Coder workspace gv-0123456789ab has commits that are not pushed', canDiscardWork: true },
  { type: 'delete-hook-result', requestId: 'r3', ok: false, error: 'Unknown hook' },
  { type: 'workspace-repos', requestId: 'r4', id: 'session-1', ok: true, repos: ['/repos/one', '/repos/two'], error: null },
  { type: 'set-workspace-repos-result', requestId: 'r5', id: 'session-1', ok: false, error: 'two has uncommitted changes. Commit or discard them before removing it from the workspace.' },
  { type: 'hooks-updated', count: 1 },
  { type: 'feature-hint', hint: { feature: 'teamReview', distinctTargetCount: 3, raisedAt: 1761740000000 } },
  { type: 'star-hint' },
  { type: 'hosts-status', hosts: [{ id: 'devbox', name: 'Devbox', sshTarget: 'devbox', dashboardPort: 3000, state: 'version-differs', hostVersion: '0.51.0', hubVersion: '0.52.3-next.0', lastError: null }] },
  { type: 'packs-status', warnings: [], packs: [
    { name: 'ci-board', version: 3, description: null, dir: '/home/me/.glimmervoid/packs/ci-board', state: 'pending', fingerprint: 'f'.repeat(64), files: ['pack.json'], needs: ['program gh'], missingRequires: [], prFlows: null, themes: [{ id: 'night-shift', label: 'Night Shift', mode: 'dark' }], panels: [{ id: 'board', label: 'CI', reads: ['sessions'], acts: ['reviews'] }], errors: [] },
    { name: 'broken', version: null, description: null, dir: '/home/me/.glimmervoid/packs/broken', state: 'invalid', fingerprint: null, files: [], needs: [], missingRequires: [], prFlows: null, themes: [], panels: [], errors: ['there is no pack.json'] },
  ], themes: [], panels: [{ viewId: 'pack:ci-board/board', pack: 'ci-board', label: 'CI', entryUrl: '/packs/ci-board/abc/files/panel/index.html', iconUrl: null, reads: ['sessions'], acts: ['reviews'] }] },
  { type: 'pack-approve-result', requestId: 'pack-1', ok: false, error: 'That pack changed or is already approved; check the list again.' },
  { type: 'pack-data-result', requestId: 'pack-2', ok: true, data: { sort: 'newest', pinned: ['acme/api#12'] } },
  { type: 'race-status', races: [{ id: 'race-1', spec: { version: 1, title: 'Fix the parser', prompt: 'Fix the parser', repoPath: '/repos/one', contestants: [{ id: 'c1', label: 'Opus high', setup: { agent: 'claude-code', model: 'claude-opus-5-5', options: [{ id: 'effort', value: 'high' }], instructions: '' }, home: 'operator' }, { id: 'c2', label: 'Codex', setup: { agent: 'codex', model: null, options: [], instructions: '' }, home: 'clean' }], judges: [{ setup: { agent: 'claude-code', model: null, options: [], instructions: '' } }], check: { program: 'npm', args: ['test'], timeoutSeconds: 600 }, timeLimitMinutes: 30, rounds: 3 }, startSha: 'a'.repeat(40), baseBranch: 'main', createdAt: 1761740000000, sessionIdByContestant: { c1: 'session-1', c2: 'session-2' }, phase: 'judged', diffStatsByContestant: { c1: { filesChanged: 2, linesAdded: 10, linesRemoved: 3 } }, metricsByContestant: { c1: { elapsedMs: 72000, tokens: 12000, costUSD: 0.04, waits: 0 }, c2: { elapsedMs: null, tokens: null, costUSD: null, waits: 1 } }, finishByContestant: { c1: { status: 'finished', reason: null }, c2: { status: 'did-not-finish', reason: 'asked: Resume spec?' } }, series: { id: 'race-1', round: 2 }, checkByContestant: { c1: { status: 'passed', exitCode: 0, reason: null, durationMs: 1200, outputTail: 'ok\n' }, c2: { status: 'unavailable', exitCode: null, reason: 'npm was not found', durationMs: 5, outputTail: '' } }, judge: null, panel: { verdicts: [{ judge: { agent: 'claude-code', model: null, label: 'claude-code' }, contestants: { c1: { criteria: { correctness: { reason: 'Fixed', pass: true }, completeness: { reason: 'All', pass: true }, scope: { reason: 'Tight', pass: true }, quality: { reason: 'Clean', pass: false } }, tier: 1, notes: 'Add the edge case' } } }], failures: [{ label: 'claude-code claude-opus-5-5', reason: 'ran out of time' }], standing: [{ contestantId: 'c1', rank: 1, criteriaPassed: 3, criteria: { correctness: 'pass', completeness: 'pass', scope: 'pass', quality: 'fail' }, meanTier: 1, summary: 'Fixed' }], firstPlaceAgreement: { agreeing: 1, judges: 1 } }, judgeError: null, winnerContestantId: 'c1' }] },
  { type: 'race-history', history: { judgedRaces: 2, standings: [{ setupKey: '["claude-code","claude-haiku-5-5",null,"clean",""]', label: 'claude-code claude-haiku-5-5, clean home', races: 2, wins: 1, passRate: { correctness: 1, completeness: 1, scope: 0.5, quality: null }, meanCostUSD: 0.04, meanElapsedMs: 60000 }], judges: [{ label: 'claude-code', matched: 1, races: 1 }], past: [] } },
  { type: 'race-start-result', requestId: 'r6', ok: true, error: null, raceId: 'race-1' },
  { type: 'race-judge-result', requestId: 'r7', ok: false, error: 'The judge is already running for this race.' },
  { type: 'race-diff-result', requestId: 'r8', ok: true, error: null, diff: 'diff --git a/x b/x' },
  { type: 'race-pick-winner-result', requestId: 'r9', ok: false, error: 'This race already has a different winner.' },
];

test('real server payloads round-trip through every server contract variant', () => {
  assert.deepEqual(new Set(REAL_SERVER_PAYLOADS.map((payload) => payload.type)), schemaTypes(ServerMessage));
  for (const payload of REAL_SERVER_PAYLOADS) {
    const parsed = ServerMessage.safeParse(payload);
    assert.equal(parsed.success, true, `${payload.type}: ${parsed.error?.issues[0]?.message || 'invalid'}`);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed.data)), payload, payload.type);
  }
});

test('a manual link resolves against my PRs, and an unlink removes it and blocks auto relink until linked again', () => {
  const session = new Session({ id: 's1', name: 'project', path: '/project' });
  try {
    const knownPrUrl = 'https://github.com/PostHog/glimmervoid/pull/42?from=status';
    const knownPr = MyPr.parse({
      key: 'PostHog/glimmervoid#42', repo: 'PostHog/glimmervoid', number: 42, title: 'PR 42', url: knownPrUrl,
      isDraft: false, state: 'MERGED', createdAt: '', mergedAt: null, updatedAt: '',
      baseRefName: 'main', baseRefOid: 'a'.repeat(40), headRefName: 'feature', isCrossRepository: false, headRefOid: 'b'.repeat(40),
      isInMergeQueue: false, mergeMethod: 'SQUASH', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
      checks: { state: null, failing: [], pendingCount: 0 }, unresolvedThreads: 0, threads: [], reviewItems: [], behindBy: null,
      reviewRequests: [], approvals: 0, reviews: [], stage: 'merged',
    });
    const snapshot = myPrsStatus({ ts: NOW, configured: true, viewer: 'octo', prs: [knownPr] });
    const broadcasts: unknown[] = [];
    session.on('pr-links-change', (prLinks) => broadcasts.push(prLinks));
    const server = createControlServer(controlDeps({ projects: [] }, {
      sessions: new Map([['s1', session]]),
      getMyPrsStatus: () => snapshot,
    }));
    const connection = connectControl<ServerPayload>(server);
    const connectedStatus = MyPrsStatus.parse(connection.sent.find((frame) => frame.type === 'my-prs-status'));
    assert.deepEqual(connectedStatus.prs, [{ key: knownPr.key }]);
    assert.equal(connectedStatus.viewer, snapshot.viewer);
    assert.equal(connectedStatus.configured, snapshot.configured);
    assert.equal(snapshot.prs[0].url, knownPrUrl);
    connection.send({ type: 'link-session-pr', id: 's1', key: 'PostHog/glimmervoid#42' });
    connection.send({ type: 'link-session-pr', id: 's1', key: 'PostHog/glimmervoid#7' });
    assert.deepEqual(session.linkedPrs.map((link) => [link.number, link.url, link.source]).sort(), [
      [42, knownPrUrl, 'manual'], [7, 'https://github.com/PostHog/glimmervoid/pull/7', 'manual'],
    ]);
    connection.send({ type: 'unlink-session-pr', id: 's1', key: 'PostHog/glimmervoid#42' });
    assert.deepEqual(session.linkedPrs.map((link) => link.number), [7]);
    session.linkPr({ repo: 'PostHog/glimmervoid', number: 42, url: knownPrUrl, source: 'hook', linkedAt: NOW });
    assert.deepEqual(session.linkedPrs.map((link) => link.number), [7]);
    connection.send({ type: 'link-session-pr', id: 's1', key: 'PostHog/glimmervoid#42' });
    assert.deepEqual(session.linkedPrs.map((link) => link.number).sort(), [42, 7]);
    assert.deepEqual(session._prLinks.unlinkedKeys, []);
    assert.equal(broadcasts.length, 4);
    connection.send({ type: 'link-session-pr', id: 'missing', key: 'PostHog/glimmervoid#42' });
    assert.equal(connection.sent.at(-1)?.type, 'error');
  } finally {
    session.destroy();
  }
});

test('server variants read by the browser validate more than their type name', () => {
  const intentionallyOpaque = new Set(['shutting-down', 'restarting', 'star-hint']);
  for (const option of ServerMessage.options) {
    const type = option.shape.type.value;
    if (intentionallyOpaque.has(type)) continue;
    assert.ok(Object.keys(option.shape).length > 1, type);
  }
});

test('a plan draft notice carries where the draft lives and when it changed, never the draft itself', () => {
  const notice = {
    type: 'session-plan-draft',
    id: 'session-1',
    agentId: null,
    planFilePath: '/home/u/.claude/plans/a.md',
    changedAt: NOW,
  };
  assert.deepEqual(ServerMessage.parse(notice), notice);
  const draftArm = ServerMessage.options.find((option) => option.shape.type.value === 'session-plan-draft');
  assert.ok(draftArm);
  assert.equal(Object.keys(draftArm.shape).includes('plan'), false, 'a notice is a nudge to ask, never a body');
  assert.equal(
    REFRESHABLE_TYPES.has('session-plan-draft'),
    false,
    'no snapshot or pull carries draft-change state, so dropping the notice loses the chip until the next write',
  );
  const { changedAt: _changedAt, ...withoutChangedAt } = notice;
  assert.equal(ServerMessage.safeParse(withoutChangedAt).success, false);
});

test('a plan summary push never carries the plan body but does carry who wrote it and when', () => {
  const summaryArm = ServerMessage.options.find((option) => option.shape.type.value === 'session-plan-changed');
  assert.ok(summaryArm);
  assert.deepEqual(Object.keys(summaryArm.shape).includes('plan'), false);
  assert.equal(REFRESHABLE_TYPES.has('session-plan-changed'), true);
  const summary = { type: 'session-plan-changed', id: 'session-1', agentId: 'agent-9', agentType: 'Explore', revision: 1, receivedAt: NOW, state: 'open', lastDecision: null, approvedRevision: null, chars: 12, title: 'Explore', hasPlan: true };
  assert.deepEqual(ServerMessage.parse(summary), summary);
  const { agentType: _agentType, ...withoutAgentType } = summary;
  assert.equal(ServerMessage.safeParse(withoutAgentType).success, false);
  const { receivedAt: _receivedAt, ...withoutReceivedAt } = summary;
  assert.equal(ServerMessage.safeParse(withoutReceivedAt).success, false);
});

test('the plan decision wire shape is the lane schema, so one edit cannot leave the two disagreeing', () => {
  const decisionArm = ClientMessage.options.find((option) => option.shape.type.value === 'plan-decision');
  assert.ok(decisionArm);
  const { type: _type, ...wireShape } = decisionArm.shape;
  assert.deepEqual(Object.keys(wireShape).sort(), Object.keys(PlanDecision.shape).sort());
  assert.equal(ClientMessage.safeParse({ type: 'plan-decision', id: 'session-1', agentId: null, revision: 1, decision: 'approve' }).success, true);
});

test('a malformed request receives its typed error reply with the Zod message', () => {
  const server = createControlServer(controlDeps({ projects: [] }));
  const connection = connectControl<ServerPayload>(server);
  connection.sent.length = 0;
  connection.send({
    type: 'request-usage-report',
    requestId: 7,
  });

  assert.equal(connection.sent.length, 1);
  const reply = connection.sent[0];
  assert.equal(reply.type, 'usage-report');
  assert.match(String(reply.error), /string/);
  assert.equal(ServerMessage.safeParse(reply).success, true);
});

test('the control socket takes the largest plan decision the caps allow, so approving an edit never closes it', () => {
  const decision = {
    type: 'plan-decision',
    id: 'session-1',
    agentId: 'agent-9',
    revision: 3,
    decision: 'revise',
    plan: 'y'.repeat(PLAN_BODY_CAP_BYTES),
    feedback: 'f'.repeat(PLAN_FEEDBACK_MAX_CHARS),
    comments: Array.from({ length: PLAN_COMMENTS_MAX }, (_entry, index) => ({
      heading: `h${index}`.padEnd(PLAN_COMMENT_MAX_CHARS, 'h'),
      comment: 'c'.repeat(PLAN_COMMENT_MAX_CHARS),
    })),
  };
  assert.equal(PlanDecision.safeParse(decision).success, true);
  const frameBytes = Buffer.byteLength(JSON.stringify(decision), 'utf8');
  assert.ok(frameBytes > 16 * 1024, 'the 16 KB default this budget replaced could not carry one edited plan');
  assert.ok(
    frameBytes <= CONTROL_FRAME_MAX_BYTES,
    `a maximal plan decision is ${frameBytes} bytes, over the ${CONTROL_FRAME_MAX_BYTES} byte control frame budget`,
  );
});

test('the control WebSocket server is built with that budget, never a hand-written number', async () => {
  const { createBackendWebSockets } = await import('../server/backend/backend-websockets.ts');
  const sockets = createBackendWebSockets({
    remote: { enabled: false, allowedOrigins: [] },
    remoteAuth: null,
    remoteListenerPort: null,
    allowedHosts: [],
    listenerPortsFor: () => [],
    tokenMatches: () => true,
    getSession: () => null,
    logger: { warn: () => {} },
  });
  const controlOptions: unknown = Reflect.get(sockets.controlWss, 'options');
  const parsed = z.object({ maxPayload: z.number() }).safeParse(controlOptions);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.maxPayload, CONTROL_FRAME_MAX_BYTES);
  sockets.controlWss.close();
  sockets.dataWss.close();
});

test('nested open objects retain declared field types and passthrough fields', () => {
  const expected = {
    type: 'session-diff',
    id: 'session',
    committed: { stat: 'one file', diff: 'committed diff', extra: 'preserved' },
    uncommitted: { stat: '', diff: '' },
    hasCommits: true,
    bases: [],
    extra: 'preserved',
  } satisfies ServerMessageOf<'session-diff'>;
  const message = ServerMessage.parse(expected);
  if (message.type !== 'session-diff') assert.fail('Expected session diff');
  const stat: string = message.committed.stat;
  const diff: string = message.uncommitted.diff;
  assert.equal(stat, 'one file');
  assert.equal(diff, '');
  assert.deepEqual(message, expected);
});
