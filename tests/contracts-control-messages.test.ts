import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { CLIENT_ERROR_NAME_MAX_CHARS, CLIENT_ERROR_STACK_MAX_CHARS, ClientMessage, ServerMessage } from '../shared/contracts/index.ts';
import {
  type ClientMessageOf,
  type ServerMessageOf,
  CONTROL_FRAME_MAX_BYTES,
  DIFF_ANNOTATION_NOTE_MAX_CHARS,
  DIFF_ANNOTATION_PATH_MAX_CHARS,
  DIFF_ANNOTATIONS_MAX,
} from '../shared/contracts/control-messages.ts';
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

test('add-session accepts workspace repository paths', () => {
  const parsed = ClientMessage.safeParse({ type: 'add-session', name: 'Workspace', path: '/repos/one', repos: ['/repos/one', '/repos/two'] });
  assert.equal(parsed.success, true);
  assert.equal(ClientMessage.safeParse({ type: 'add-session', name: 'Workspace', path: '/repos/one', repos: 'bad' }).success, false);
});

function dispatchTypes(file: string, startMarker: string, endMarker: string): string[] {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', file), 'utf8');
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return [...source.slice(start, end).matchAll(/^\s*['"]([a-z][a-z0-9-]*)['"]\s*:/gm)].map((match) => match[1]);
}

function schemaTypes(schema: typeof ClientMessage | typeof ServerMessage): Set<string> {
  return new Set(schema.options.map((option) => option.shape.type.value));
}

test('control dispatch tables contain only contract message types', () => {
  const clientTypes = dispatchTypes('server/control-handlers.ts', 'const handlers = {', "controlWss.on('connection'");
  const serverTypes = dispatchTypes('public/app.ts', 'const messageHandlers = {', 'onControlMessage((msg)');
  const clientSchemaTypes = schemaTypes(ClientMessage);
  const serverSchemaTypes = schemaTypes(ServerMessage);
  assert.deepEqual(clientTypes.filter((type) => !clientSchemaTypes.has(type)), []);
  assert.deepEqual(serverTypes.filter((type) => !serverSchemaTypes.has(type)), []);
});

test('the browser dispatches update-progress from the complete contract table', () => {
  const serverTypes = dispatchTypes('public/app.ts', 'const messageHandlers = {', 'onControlMessage((msg)');
  assert.equal(serverTypes.includes('update-progress'), true);
  assert.equal(schemaTypes(ServerMessage).has('update-progress'), true);
});

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
  sleeping: false,
  taskTitle: null,
  taskTitleIsCustom: false,
  dangerouslySkipPermissions: true,
  saneYolo: true,
  ephemeral: false,
  isWorktree: true, isWorkspace: false,
  resumeSessionId: null,
  activeAgents: 0,
  awaitingBackgroundTasks: false,
  isCompacting: false,
  hasEndedTurn: false,
  pendingWakeup: null,
  pendingPromptKind: null,
  pendingPromptDetail: null,
  hasPlan: false,
  mergeStatus: 'none',
  mergeReason: null,
  worktreeNotice: null,
  effectiveBase: 'develop',
  auditLog: [],
};

const REAL_SERVER_PAYLOADS: ServerPayload[] = [
  { type: 'snapshot', sessions: [SESSION], serverBuild: 'build-1' },
  { type: 'state-change', id: 'session-1', session: 'glimmervoid', from: STATES.IDLE, to: STATES.RUNNING, event: 'user_input', timestamp: NOW, hasEndedTurn: true },
  { type: 'session-added', id: 'session-1', session: 'glimmervoid', path: '/repo/glimmervoid', agent: 'claude-code', state: STATES.DORMANT, stateSince: NOW, skipPerms: true, saneYolo: true, worktree: false, resumeSessionId: null },
  { type: 'session-removed', id: 'session-1', session: 'glimmervoid' },
  { type: 'session-renamed', id: 'session-1', oldName: 'old', newName: 'glimmervoid' },
  { type: 'session-title', id: 'session-1', taskTitle: 'Fix dashboard', isCustom: false },
  { type: 'session-modified', id: 'session-1', session: 'glimmervoid', path: '/repo/glimmervoid', agent: 'claude-code', state: STATES.DORMANT, stateSince: NOW, skipPerms: true, saneYolo: true, worktree: false, resumeSessionId: null },
  { type: 'session-git', id: 'session-1', worktree: true },
  { type: 'session-agents', id: 'session-1', activeAgents: 2, awaitingBackgroundTasks: true, session: 'glimmervoid', timestamp: NOW },
  { type: 'session-wakeup', id: 'session-1', pendingWakeup: { at: NOW, kind: 'cron', reason: null }, session: 'glimmervoid', timestamp: NOW },
  { type: 'session-prompt', id: 'session-1', pendingPromptKind: 'permission', session: 'glimmervoid', timestamp: NOW },
  { type: 'session-sleep', id: 'session-1', session: 'glimmervoid', timestamp: NOW },
  { type: 'session-wake', id: 'session-1', session: 'glimmervoid', timestamp: NOW },
  { type: 'session-merge-status', id: 'session-1', session: 'glimmervoid', mergeStatus: 'pending-review', reason: null, parked: false, timestamp: NOW },
  { type: 'session-worktree-blocked', id: 'session-1', session: 'glimmervoid', branch: 'develop', notice: 'missing branch', timestamp: NOW },
  { type: 'session-worktree-ready', id: 'session-1', session: 'glimmervoid', branch: 'glimmervoid/session/1', base: 'develop', timestamp: NOW },
  { type: 'session-diff', id: 'session-1', committed: { stat: '1 file', diff: 'patch' }, uncommitted: { stat: '', diff: '' }, hasCommits: true },
  { type: 'change-map', id: 'session-1', map: { sessionId: 'session-1', sig: 'sig-1', generatedAt: NOW, repos: [], narrative: null, narratorState: 'disabled' } },
  { type: 'send-diff-annotations-result', requestId: 'r9', ok: true, error: null, pending: false },
  { type: 'branch-sync-status', id: 'session-1', branch: 'develop', upstream: 'origin/develop', state: 'ahead', ahead: 1, behind: 0, fetched: true },
  { type: 'session-changed', id: 'session-1', sig: 'sha' },
  { type: 'post-turn-result', id: 'session-1', session: 'glimmervoid', mode: 'fix', skipped: null, filesFixed: 1, findings: [{ file: 'a.js', rule: 'finalNewline', count: 1 }], timestamp: NOW },
  { type: 'debug-state-response', id: 'session-1', payload: { state: STATES.RUNNING } },
  { type: 'session-trace-response', id: 'session-1', records: [], start: 0, next: 0, reset: false, path: '/traces/session-1.jsonl' },
  { type: 'session-trace-changed', id: 'session-1' },
  { type: 'session-plan-changed', id: 'session-1', agentId: null, agentType: null, revision: 2, receivedAt: NOW, state: 'open', lastDecision: null, approvedRevision: null, chars: 8454, title: 'Shrink the large owned files', hasPlan: true },
  { type: 'session-plan-draft', id: 'session-1', agentId: null, planFilePath: '/home/u/.claude/plans/a.md', changedAt: NOW },
  { type: 'session-plan-response', id: 'session-1', reviews: [PLAN_REVIEW], body: { agentId: 'agent-9', revision: 2, plan: '# Shrink the large owned files', planFilePath: '/home/u/.claude/plans/a.md', receivedAt: NOW } },
  { type: 'notify', session: 'session-1', category: 'complete', message: 'finished', escalationCount: 0 },
  {
    type: 'update-status', updateAvailable: true, current: '0.23.1', latest: '0.24.0', currentSha: null,
    latestSha: '0123456789abcdef0123456789abcdef01234567', releaseUrl: 'https://example.test/release',
    command: 'npm install', flavor: 'npm-global', platform: 'linux', installedBranch: null, upstream: null, isTreeClean: null,
    lastCheckAt: NOW, channel: 'release', behindCount: null, reason: null,
    journalSummary: { state: 'staged', activeStep: null, reason: null, startedAt: NOW, finishedAt: NOW + 2 },
    applyRefusal: { reason: 'already-staged', message: 'Restart to apply the staged update.' },
  },
  { type: 'update-progress', journal: UPDATE_JOURNAL },
  { type: 'error', message: 'refused' },
  { type: 'session-error', id: 'session-1', session: 'glimmervoid', message: 'failed' },
  { type: 'settings', requestId: 'settings-1', settings: { cursorBlink: false } },
  { type: 'settings-error', requestId: 'settings-1', message: 'invalid' },
  { type: 'settings-updated', requestId: 'settings-1', settings: { cursorBlink: true } },
  { type: 'pong', requestId: 'ping-1' },
  { type: 'agents-listed', requestId: 'agents-1', agents: [{ id: 'claude-code', label: 'Claude Code', resolvable: true }] },
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
  { type: 'posthog-status', ts: NOW, intervalMinutes: 15, projects: [], investigations: [] },
  { type: 'posthog-investigation-activity', projectId: 7, issueId: 'issue-1', inFlight: true, startedAt: NOW, trail: [{ at: NOW, tool: 'Read', detail: 'server/a.ts' }] },
  { type: 'posthog-investigation-finished', projectId: 7, issueId: 'issue-1', verdict: 'NEEDS_HUMAN', summaryLine: 'the retry path double-fires', startedAt: NOW, trail: [{ at: NOW, tool: 'Read', detail: 'server/a.ts' }] },
  { type: 'posthog-report', requestId: 'posthog-1', ok: true, found: true, issueId: 'issue-1', format: 'markdown', content: 'report' },
  { type: 'posthog-open-session-result', requestId: 'posthog-2', ok: true, error: null, sessionId: 'session-1' },
  { type: 'issues-report', requestId: 'issues-1', ts: NOW, projectId: 'p1', issues: [{ number: 42, title: 'Reconnect drops queued writes', labels: [{ name: 'bug', color: 'ff0000' }], url: 'https://github.test/acme/repo/issues/42', updatedAt: '2026-09-13T10:00:00Z' }], error: null },
  { type: 'open-issue-session-result', requestId: 'issues-2', ok: true, error: null, sessionId: 'session-2', sessionName: 'issue-42-fix-reconnect', pending: false },
  { type: 'posthog-issue-action-result', requestId: 'posthog-3', ok: true, error: null, status: 'resolved' },
  { type: 'team-review-action-result', requestId: 'review-1', key: 'PostHog/wizard#1350', ok: true },
  { type: 'reviews-refresh-result', requestId: 'refresh-1', ok: true },
  { type: 'benchmark-action-result', requestId: 'bench-1', suiteId: 'review-ladder', action: 'run', ok: true, runId: 'run-1' },
  { type: 'factory-state', ts: NOW, projects: [{
    projectId: 'project-1', projectName: 'Factory', headSha: 'a'.repeat(40), error: null,
    heading: { action: 'dispatch', reasons: ['ready work'] },
    orders: [{ id: 'work-1', objective: 'Fix retries', criteria: ['Retry test passes'], risk: 'high', state: 'open', readiness: 'ready', parent: null, dependsOn: [], writeScopes: ['src/retry.ts'], owner: 'session-1', lastEvent: null }],
    conflicts: [], unverifiedCompletedWork: [],
  }] },
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
  { type: 'posthog-archive-investigation-result', requestId: 'posthog-4', ok: true, error: null },
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
  }], handReview: [], queued: [{
    key: 'PostHog/wizard#1352', repo: 'PostHog/wizard', number: 1352, title: 'Move files',
    url: 'https://github.com/PostHog/wizard/pull/1352', author: 'teammate', requestSource: 'team',
  }] },
  { type: 'my-prs-status', ts: NOW, configured: true, viewer: 'alice', prs: [], error: null },
  { type: 'branch-gc-status', ts: NOW, projects: [] },
  { type: 'usage-sessions', ts: NOW, pricingSource: 'bundled', sessions: [{ id: 'session-1', tokens: 123, costUSD: 0.5, officialCostUSD: null }] },
  { type: 'usage-report', requestId: 'usage-1', ts: NOW, tz: 'UTC', blockHours: 5, totals: {}, daily: [], models: [], sessions: [], blocks: [], activeBlock: null, anomaly: null, byLane: {}, budget: {}, savings: {}, tokenLimit: null, pricing: {}, scan: {}, warning: null, error: null },
  { type: 'plan-limits', ts: NOW, fiveHour: { pct: 10, resetsAtMs: NOW + 1000 }, sevenDay: null, source: 'statusline' },
  { type: 'usage-budget-alert', scope: 'daily', periodKey: '2026-08-26', threshold: 50, spentUsd: 5, budgetUsd: 10, text: 'budget crossed', ts: NOW },
  { type: 'visions-findings', uri: 'file:///repo/a.js', diagnostics: [], ts: NOW },
  { type: 'visions-comments', uri: 'file:///repo/a.js', comments: [], ts: NOW },
  { type: 'visions-hand', uri: 'file:///repo/a.js', hand: null, ts: NOW },
  { type: 'visions-intent', projectId: null, intent: { text: 'intent', source: 'model', ts: NOW }, ts: NOW },
  { type: 'visions-fix', uri: 'file:///repo/a.js', fix: { code: 'x', line: 1, message: 'fixed', applied: true }, ts: NOW },
  { type: 'visions-snapshot', documents: [], intent: { global: null, byProject: {} }, fixes: [], ts: NOW },
  { type: 'ingest-activity', events: [], overflow: 0, ts: NOW },
  { type: 'ingest-snapshot', events: [], sources: { terminal: true }, ts: NOW },
  { type: 'client-trust', trust: 'local' },
  { type: 'sessions-reordered', order: ['session-1'] },
  { type: 'session-worktree-warning', id: 'session-1', session: 'Session 1', branch: 'glimmervoid/session/session-1', notice: 'offline', timestamp: NOW },
  { type: 'shutting-down' },
  { type: 'restarting' },
  {
    type: 'hooks-report', requestId: 'r1', ts: NOW,
    hooks: [{ id: 'h1', name: 'lint', event: 'PostToolUse', matcher: 'Edit', type: 'command', command: 'npm run lint', enabled: true }],
    builtin: [{ event: 'Stop', matcher: null, purpose: 'Status detection' }],
    events: [{ name: 'PostToolUse', matcher: 'tool name (regex)', description: 'After a tool succeeds.' }],
    projects: [{ id: 'p1', name: 'glimmervoid', agent: 'claude-code' }],
    limits: { maxTimeoutSec: 600 },
    error: null,
  },
  { type: 'save-hook-result', requestId: 'r2', ok: true, error: null, hook: { id: 'h1' } },
  { type: 'delete-hook-result', requestId: 'r3', ok: false, error: 'Unknown hook' },
  { type: 'hooks-updated', count: 1 },
];

test('real server payloads round-trip through every server contract variant', () => {
  assert.deepEqual(new Set(REAL_SERVER_PAYLOADS.map((payload) => payload.type)), schemaTypes(ServerMessage));
  for (const payload of REAL_SERVER_PAYLOADS) {
    const parsed = ServerMessage.safeParse(payload);
    assert.equal(parsed.success, true, `${payload.type}: ${parsed.error?.issues[0]?.message || 'invalid'}`);
    assert.deepEqual(parsed.data, payload, payload.type);
  }
});

test('session-added and session-modified reject a card that does not name its agent', () => {
  for (const type of ['session-added', 'session-modified']) {
    const card = { type, id: 'session-1', session: 'glimmervoid', path: '/repo/glimmervoid', agent: 'codex', state: STATES.DORMANT, stateSince: NOW, skipPerms: false, saneYolo: false, worktree: false, resumeSessionId: null };
    assert.equal(ServerMessage.parse(card).agent, 'codex', type);
    const { agent: _omittedAgent, ...cardWithoutAgent } = card;
    assert.equal(ServerMessage.safeParse(cardWithoutAgent).success, false, type);
  }
});

test('session-prompt parses with and without a pending prompt detail and rejects a malformed one', () => {
  const prompt = { type: 'session-prompt', id: 'session-1', pendingPromptKind: 'permission', session: 'glimmervoid', timestamp: NOW };
  assert.equal(ServerMessage.safeParse(prompt).success, true);
  assert.equal(ServerMessage.safeParse({ ...prompt, pendingPromptDetail: null }).success, true);
  const detailed = { ...prompt, pendingPromptDetail: { toolName: 'Bash', summary: 'npm test', isComplete: true } };
  assert.deepEqual(ServerMessage.parse(detailed), detailed);
  assert.equal(ServerMessage.safeParse({ ...prompt, pendingPromptDetail: 'npm test' }).success, false);
  assert.equal(ServerMessage.safeParse({ ...prompt, pendingPromptDetail: { toolName: 'Bash', isComplete: true } }).success, false);
  assert.equal(ServerMessage.safeParse({ ...prompt, pendingPromptDetail: { toolName: 'Bash', summary: 'npm test' } }).success, false);
  assert.equal(ServerMessage.safeParse({ ...prompt, pendingPromptDetail: { toolName: 'Bash', summary: 'npm test', isComplete: 'yes' } }).success, false);
  assert.equal(ServerMessage.safeParse({ ...prompt, pendingPromptDetail: { toolName: 'Bash', summary: 'x'.repeat(161), isComplete: false } }).success, false);
});

test('session-prompt parses a pending prompt detail with and without an AskUserQuestion question and rejects a malformed one', () => {
  const prompt = { type: 'session-prompt', id: 'session-1', pendingPromptKind: 'permission', session: 'glimmervoid', timestamp: NOW };
  const question = { text: 'Which database?', options: ['Postgres', 'SQLite'], multiSelect: false };
  const detailWith = (questionValue: unknown) => ({ ...prompt, pendingPromptDetail: { toolName: 'AskUserQuestion', summary: '', isComplete: false, question: questionValue } });
  assert.deepEqual(ServerMessage.parse(detailWith(question)), detailWith(question));
  assert.deepEqual(ServerMessage.parse(detailWith(null)), detailWith(null));
  const withoutQuestion = { ...prompt, pendingPromptDetail: { toolName: 'AskUserQuestion', summary: '', isComplete: false } };
  assert.deepEqual(ServerMessage.parse(withoutQuestion), withoutQuestion);
  assert.equal(ServerMessage.safeParse(detailWith({ ...question, text: 'q'.repeat(300), options: Array.from({ length: 8 }, () => 'x'.repeat(80)) })).success, true);
  for (const malformed of [
    'Which database?',
    { ...question, text: '' },
    { ...question, text: 'q'.repeat(301) },
    { ...question, text: `Which${String.fromCharCode(0x202e)}database?` },
    { ...question, options: [] },
    { ...question, options: Array.from({ length: 9 }, () => 'x') },
    { ...question, options: ['x'.repeat(81)] },
    { ...question, options: [''] },
    { ...question, options: [`SQ${String.fromCharCode(0x1b)}Lite`] },
    { ...question, multiSelect: 'no' },
    { text: 'Which database?', options: ['Postgres'] },
  ]) {
    assert.equal(ServerMessage.safeParse(detailWith(malformed)).success, false, JSON.stringify(malformed));
  }
});

test('GitHub issue client requests validate their bounded fields', () => {
  assert.deepEqual(ClientMessage.parse({ type: 'request-issues', requestId: 'r1', projectId: 'p1' }), {
    type: 'request-issues', requestId: 'r1', projectId: 'p1',
  });
  assert.deepEqual(ClientMessage.parse({ type: 'open-issue-session', requestId: 'r2', projectId: 'p1', issueNumber: 42 }), {
    type: 'open-issue-session', requestId: 'r2', projectId: 'p1', issueNumber: 42,
  });
  assert.equal(ClientMessage.safeParse({ type: 'open-issue-session', requestId: 'r2', projectId: 'p1', issueNumber: 0 }).success, false);
});

test('team review actions carry editable text and diff comments', () => {
  const action = {
    type: 'team-review-action', requestId: 'review-1', key: 'PostHog/wizard#1350',
    head: 'a'.repeat(40), action: 'comment', body: 'Please check this line',
    comments: [{ path: 'src/agent/index.ts', line: 4, side: 'RIGHT', body: 'Check this' }],
  };
  assert.deepEqual(ClientMessage.parse(action), action);
  const requeue = { ...action, action: 'requeue', body: '', comments: [] };
  assert.deepEqual(ClientMessage.parse(requeue), requeue);
  for (const invalid of [
    { ...action, action: 'merge' },
    { ...action, comments: [{ path: 'src/agent/index.ts', line: 0, body: 'Check this' }] },
    { ...action, body: 4 },
    { ...action, head: undefined },
    { ...action, head: 'A'.repeat(40) },
    { ...action, head: 'a'.repeat(39) },
    { ...action, key: '' },
  ]) assert.equal(ClientMessage.safeParse(invalid).success, false);
  assert.equal(ServerMessage.safeParse({ type: 'team-review-action-result', key: action.key, ok: false, error: 'stale head' }).success, true);
  assert.equal(ServerMessage.safeParse({ type: 'team-review-action-result', key: action.key, ok: true, warning: 'Do not post it again' }).success, true);
  assert.equal(ServerMessage.safeParse({ type: 'team-review-action-result', key: action.key, ok: true, warning: 4 }).success, false);
});

test('benchmark actions name a suite and one of the three actions', () => {
  const action = { type: 'benchmark-action', requestId: 'bench-1', suiteId: 'review-ladder', action: 'mine' };
  assert.deepEqual(ClientMessage.parse(action), action);
  for (const invalid of [
    { ...action, action: 'freeze' },
    { ...action, suiteId: '../escape' },
    { ...action, suiteId: '' },
    { ...action, suiteId: undefined },
  ]) assert.equal(ClientMessage.safeParse(invalid).success, false);
  assert.equal(ServerMessage.safeParse({ type: 'benchmark-action-result', suiteId: 'review-ladder', action: 'cancel', ok: false, error: 'No run in flight' }).success, true);
  assert.equal(ServerMessage.safeParse({ type: 'benchmark-action-result', suiteId: 'review-ladder', action: 'cancel', ok: 'no' }).success, false);
});

test('my pull request merges carry the repository, number and the head the dashboard saw', () => {
  const merge = { type: 'my-pr-merge', requestId: 'merge-1', repo: 'PostHog/wizard', number: 1350, headRefOid: 'a'.repeat(40) };
  assert.deepEqual(ClientMessage.parse(merge), merge);
  for (const invalid of [
    { ...merge, headRefOid: undefined },
    { ...merge, headRefOid: 'A'.repeat(40) },
    { ...merge, headRefOid: 'a'.repeat(39) },
    { ...merge, repo: 'wizard' },
    { ...merge, repo: '--repo/evil' },
    { ...merge, number: 0 },
    { ...merge, number: '1350' },
  ]) assert.equal(ClientMessage.safeParse(invalid).success, false);
  assert.equal(ServerMessage.safeParse({ type: 'my-pr-merge-result', requestId: 'merge-1', key: 'PostHog/wizard#1350', ok: true }).success, true);
  assert.equal(ServerMessage.safeParse({ type: 'my-pr-merge-result', key: 'PostHog/wizard#1350', ok: 'yes' }).success, false);
  assert.equal(ServerMessage.safeParse({ type: 'my-pr-merge-result', key: 'PostHog/wizard#1350', ok: false, error: 4 }).success, false);
});

test('team review status carries typed drafts, not an opaque project list', () => {
  const status = { type: 'team-review-status', ts: NOW, configured: false, reason: null, drafts: [], inFlight: [] };
  assert.equal(ServerMessage.safeParse(status).success, true);
  for (const invalid of [
    { ...status, drafts: undefined },
    { ...status, inFlight: [7] },
    { ...status, inFlight: ['PostHog/wizard#1351'] },
    { ...status, drafts: [{ key: 'PostHog/wizard#1' }] },
  ]) assert.equal(ServerMessage.safeParse(invalid).success, false);
});

test('send-diff-annotations bounds every field of every note', () => {
  const note = { section: 'committed', path: 'public/app.ts', line: 12, side: 'new', note: 'rename this' };
  assert.deepEqual(ClientMessage.parse({ type: 'send-diff-annotations', id: 'session-1', requestId: 'r1', annotations: [note] }), {
    type: 'send-diff-annotations', id: 'session-1', requestId: 'r1', annotations: [note],
  });

  assert.equal(ClientMessage.safeParse({ type: 'send-diff-annotations', id: 'session-1', annotations: [] }).success, false);
  assert.equal(ClientMessage.safeParse({ type: 'send-diff-annotations', id: 'session-1', annotations: [{ ...note, line: 0 }] }).success, false);
  assert.equal(ClientMessage.safeParse({ type: 'send-diff-annotations', id: 'session-1', annotations: [{ ...note, line: 1.5 }] }).success, false);
  assert.equal(ClientMessage.safeParse({ type: 'send-diff-annotations', id: 'session-1', annotations: [{ ...note, note: '' }] }).success, false);
  assert.equal(ClientMessage.safeParse({ type: 'send-diff-annotations', id: 'session-1', annotations: [{ ...note, path: '' }] }).success, false);
  assert.equal(ClientMessage.safeParse({ type: 'send-diff-annotations', id: 'session-1', annotations: [{ ...note, path: `public/app.ts${String.fromCharCode(27)}[201~` }] }).success, false);
  assert.equal(ClientMessage.safeParse({ type: 'send-diff-annotations', id: 'session-1', annotations: [{ ...note, path: `public/app.ts${String.fromCharCode(10)}` }] }).success, false);
  assert.equal(ClientMessage.safeParse({ type: 'send-diff-annotations', id: 'session-1', annotations: [{ ...note, path: 'x'.repeat(DIFF_ANNOTATION_PATH_MAX_CHARS + 1) }] }).success, false);
  assert.equal(ClientMessage.safeParse({ type: 'send-diff-annotations', id: 'session-1', annotations: [{ ...note, note: 'x'.repeat(DIFF_ANNOTATION_NOTE_MAX_CHARS) }] }).success, true);
  assert.equal(ClientMessage.safeParse({ type: 'send-diff-annotations', id: 'session-1', annotations: [{ ...note, side: 'both' }] }).success, false);
  assert.equal(ClientMessage.safeParse({ type: 'send-diff-annotations', id: 'session-1', annotations: [{ ...note, section: 'staged' }] }).success, false);
  const noteWithoutSection: Record<string, unknown> = { ...note };
  delete noteWithoutSection.section;
  assert.equal(ClientMessage.safeParse({ type: 'send-diff-annotations', id: 'session-1', annotations: [noteWithoutSection] }).success, false);
  assert.equal(ClientMessage.safeParse({ type: 'send-diff-annotations', id: 'session-1', annotations: [{ ...note, note: 'x'.repeat(DIFF_ANNOTATION_NOTE_MAX_CHARS + 1) }] }).success, false);
  assert.equal(ClientMessage.safeParse({ type: 'send-diff-annotations', id: 'session-1', annotations: [{ ...note, hunk: 3 }] }).success, false);

  const atCap = Array.from({ length: DIFF_ANNOTATIONS_MAX }, (_unused, index) => ({ ...note, line: index + 1 }));
  assert.equal(ClientMessage.safeParse({ type: 'send-diff-annotations', id: 'session-1', annotations: atCap }).success, true);
  assert.equal(ClientMessage.safeParse({
    type: 'send-diff-annotations',
    id: 'session-1',
    annotations: [...atCap, { ...note, line: DIFF_ANNOTATIONS_MAX + 1 }],
  }).success, false);
});

test('session-diff pins the object payload returned by Session.getDiff', () => {
  const invalid = ServerMessage.safeParse({
    type: 'session-diff',
    id: 'session-1',
    committed: 'patch',
    uncommitted: 'patch',
    hasCommits: true,
  });
  assert.equal(invalid.success, false);
});

test('server variants read by the browser validate more than their type name', () => {
  const intentionallyOpaque = new Set(['session-sleep', 'session-wake', 'branch-gc-status', 'shutting-down', 'restarting']);
  for (const option of ServerMessage.options) {
    const type = option.shape.type.value;
    if (intentionallyOpaque.has(type)) continue;
    assert.ok(Object.keys(option.shape).length > 1, type);
  }
});

test('a plan request carries the agent the review belongs to', () => {
  assert.deepEqual(
    ClientMessage.parse({ type: 'session-plan', id: 'session-1', agentId: null }),
    { type: 'session-plan', id: 'session-1', agentId: null },
  );
  assert.deepEqual(
    ClientMessage.parse({ type: 'session-plan', id: 'session-1', agentId: 'agent-9', revision: 3 }),
    { type: 'session-plan', id: 'session-1', agentId: 'agent-9', revision: 3 },
  );
  assert.equal(ClientMessage.safeParse({ type: 'session-plan', id: 'session-1' }).success, false);
  assert.equal(ClientMessage.safeParse({ type: 'session-plan', id: 'session-1', agentId: null, revision: 0 }).success, false);
  assert.deepEqual(
    ClientMessage.parse({ type: 'session-plan', id: 'session-1', agentId: null, draft: true }),
    { type: 'session-plan', id: 'session-1', agentId: null, draft: true },
  );
  assert.equal(ClientMessage.safeParse({ type: 'session-plan', id: 'session-1', agentId: null, draft: 'yes' }).success, false);
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

test('a plan response carries the whole review index, and its body is present or explicitly absent', () => {
  const index = { type: 'session-plan-response', id: 'session-1', reviews: [PLAN_REVIEW], body: null };
  assert.deepEqual(ServerMessage.parse(index), index);
  assert.equal(ServerMessage.safeParse({ type: 'session-plan-response', id: 'session-1', reviews: [PLAN_REVIEW] }).success, false);
  assert.equal(ServerMessage.safeParse({
    type: 'session-plan-response', id: 'session-1', reviews: [PLAN_REVIEW],
    body: { agentId: null, revision: 1, plan: '# Ship it', receivedAt: NOW },
  }).success, false);
});

test('the plan decision wire shape is the lane schema, so one edit cannot leave the two disagreeing', () => {
  const decisionArm = ClientMessage.options.find((option) => option.shape.type.value === 'plan-decision');
  assert.ok(decisionArm);
  const { type: _type, ...wireShape } = decisionArm.shape;
  assert.deepEqual(Object.keys(wireShape).sort(), Object.keys(PlanDecision.shape).sort());
  assert.equal(ClientMessage.safeParse({ type: 'plan-decision', id: 'session-1', agentId: null, revision: 1, decision: 'approve' }).success, true);
});

test('both error frames declare the scope and the id the plan face keys on', () => {
  for (const type of ['error', 'session-error']) {
    const arm = ServerMessage.options.find((option) => option.shape.type.value === type);
    assert.ok(arm, type);
    assert.ok(Object.keys(arm.shape).includes('scope'), type);
    assert.ok(Object.keys(arm.shape).includes('id'), `${type} routes to a card by id, never through passthrough`);
  }
  assert.equal(ServerMessage.parse({ type: 'error', id: 'session-1', message: 'Plan revision not found', scope: 'plan' }).id, 'session-1');
  assert.equal(ServerMessage.parse({ type: 'error', id: 'session-1', message: 'Plan revision not found', scope: 'plan' }).scope, 'plan');
  assert.equal(
    ServerMessage.parse({ type: 'session-error', id: 'session-1', session: 'glimmervoid', message: 'refused', scope: 'plan-decision' }).scope,
    'plan-decision',
  );
});

test('id-only client variants reject the removed session-name fallback', () => {
  assert.equal(ClientMessage.safeParse({ type: 'kill', session: 'glimmervoid' }).success, false);
  assert.equal(ClientMessage.safeParse({ type: 'kill', id: 'session-1' }).success, true);
});

test('a session-trace request carries either a forward cursor or a page-ending cursor', () => {
  assert.equal(ClientMessage.parse({ type: 'session-trace', id: 'session-1' }).type, 'session-trace');
  const forward = ClientMessage.parse({ type: 'session-trace', id: 'session-1', after: 512 });
  assert.deepEqual(forward, { type: 'session-trace', id: 'session-1', after: 512 });
  const tail = ClientMessage.parse({ type: 'session-trace', id: 'session-1', endingAt: 'tail' });
  assert.deepEqual(tail, { type: 'session-trace', id: 'session-1', after: 0, endingAt: 'tail' });
  const earlier = ClientMessage.parse({ type: 'session-trace', id: 'session-1', endingAt: 4096 });
  assert.deepEqual(earlier, { type: 'session-trace', id: 'session-1', after: 0, endingAt: 4096 });
  assert.equal(ClientMessage.safeParse({ type: 'session-trace', id: 'session-1', endingAt: 'head' }).success, false);
  assert.equal(ClientMessage.safeParse({ type: 'session-trace', id: 'session-1', endingAt: -1 }).success, false);
});

test('update requests carry only their type beside the request envelope', () => {
  for (const type of ['update-check', 'update-apply']) {
    assert.equal(ClientMessage.safeParse({ type }).success, true);
    const parsed = ClientMessage.parse({ type, requestId: 'r1' });
    assert.deepEqual(Object.keys(parsed).filter((key) => key !== 'type' && key !== 'requestId'), []);
  }
});

test('update-apply may ask for a restart once staged, as a boolean only', () => {
  assert.equal(ClientMessage.parse({ type: 'update-apply', restartWhenStaged: true }).restartWhenStaged, true);
  assert.equal(ClientMessage.safeParse({ type: 'update-apply', restartWhenStaged: 'yes' }).success, false);
});

test('update-apply carries the confirmed session ids as an array of non-empty strings', () => {
  assert.deepEqual(ClientMessage.parse({ type: 'update-apply', restartWhenStaged: true, confirmedSessionIds: ['session-a', 'session-b'] }).confirmedSessionIds, ['session-a', 'session-b']);
  assert.equal(ClientMessage.safeParse({ type: 'update-apply', restartWhenStaged: true, confirmedSessionIds: 'session-a' }).success, false);
  assert.equal(ClientMessage.safeParse({ type: 'update-apply', restartWhenStaged: true, confirmedSessionIds: [''] }).success, false);
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
  const { createBackendWebSockets } = await import('../server/backend-websockets.ts');
  const sockets = createBackendWebSockets({
    remote: { enabled: false, allowedOrigins: [] },
    remoteAuth: null,
    remoteListenerPort: null,
    allowedHosts: [],
    listenerPortsFor: () => [],
    tokenMatches: () => true,
    getSession: () => null,
    getVisionsLane: () => null,
    logger: { warn: () => {} },
  });
  const controlOptions: unknown = Reflect.get(sockets.controlWss, 'options');
  const parsed = z.object({ maxPayload: z.number() }).safeParse(controlOptions);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.maxPayload, CONTROL_FRAME_MAX_BYTES);
  sockets.controlWss.close();
  sockets.dataWss.close();
});

test('a client-error report is accepted within its length limits and rejected beyond them', () => {
  const within = { type: 'client-error', name: 'E'.repeat(CLIENT_ERROR_NAME_MAX_CHARS), stack: 's'.repeat(CLIENT_ERROR_STACK_MAX_CHARS) };
  assert.equal(ClientMessage.safeParse(within).success, true);
  assert.equal(ClientMessage.safeParse({ ...within, name: 'E'.repeat(CLIENT_ERROR_NAME_MAX_CHARS + 1) }).success, false);
  assert.equal(ClientMessage.safeParse({ ...within, stack: 's'.repeat(CLIENT_ERROR_STACK_MAX_CHARS + 1) }).success, false);
  assert.equal(ClientMessage.safeParse({ type: 'client-error', name: 'TypeError' }).success, false);
});

test('branch sync messages narrow to their literal discriminant and declared field types', () => {
  const expected = {
    type: 'branch-sync-status',
    id: 'session',
    branch: 'feature',
    upstream: null,
    state: 'ahead',
    ahead: 2,
    behind: 0,
    fetched: null,
    error: null,
    extra: 'preserved',
  } satisfies ServerMessageOf<'branch-sync-status'>;
  const message = ServerMessage.parse(expected);
  if (message.type !== 'branch-sync-status') assert.fail('Expected branch sync');
  const branchSync: ServerMessageOf<'branch-sync-status'> = message;
  const branch: string | null = branchSync.branch;
  const ahead: number = branchSync.ahead;
  const fetched: boolean | null = branchSync.fetched;
  assert.equal(branch, 'feature');
  assert.equal(ahead, 2);
  assert.equal(fetched, null);
  assert.deepEqual(branchSync, expected);
});

test('mapped ID-only client variants can be extracted independently and retain passthrough fields', () => {
  const kill = { type: 'kill', id: 'session', force: true, extra: 'preserved' } satisfies ClientMessageOf<'kill'>;
  const resync = { type: 'resync-branch', id: 'session' } satisfies ClientMessageOf<'resync-branch'>;
  const message = ClientMessage.parse(kill);
  if (message.type !== 'kill') assert.fail('Expected kill');
  const killRequest: ClientMessageOf<'kill'> = message;
  const id: string = killRequest.id;
  const type: 'kill' = killRequest.type;
  assert.equal(id, 'session');
  assert.equal(type, 'kill');
  assert.deepEqual(killRequest, kill);
  assert.deepEqual(ClientMessage.parse(resync), resync);
});

test('no-shape messages retain literal types and passthrough fields', () => {
  const expected = { type: 'shutdown', extra: 'preserved' } satisfies ClientMessageOf<'shutdown'>;
  const message = ClientMessage.parse(expected);
  if (message.type !== 'shutdown') assert.fail('Expected shutdown');
  const shutdown: ClientMessageOf<'shutdown'> = message;
  const type: 'shutdown' = shutdown.type;
  assert.equal(type, 'shutdown');
  assert.deepEqual(shutdown, expected);
});

test('factory snapshots are sent on connect only when the lane has state', () => {
  const snapshot = { type: 'factory-state' as const, ts: NOW, projects: [] };
  for (const state of [null, snapshot]) {
    const server = createControlServer(controlDeps({ projects: [] }, { getFactoryState: () => state }));
    const connection = connectControl<ServerPayload>(server);
    assert.deepEqual(connection.sent.filter((message) => message.type === 'factory-state'), state ? [state] : []);
    server.close();
  }
});

test('nested open objects retain declared field types and passthrough fields', () => {
  const expected = {
    type: 'session-diff',
    id: 'session',
    committed: { stat: 'one file', diff: 'committed diff', extra: 'preserved' },
    uncommitted: { stat: '', diff: '' },
    hasCommits: true,
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


test('state-change accepts Sane YOLO alongside skipPerms and rejects a non-boolean', () => {
  const change = { type: 'state-change', id: 'session-1', session: 'glimmervoid', from: STATES.DORMANT, to: STATES.INITIALIZING, event: 'start', timestamp: NOW, skipPerms: true };
  for (const saneYolo of [true, false]) {
    assert.deepEqual(ServerMessage.parse({ ...change, saneYolo }), { ...change, saneYolo });
  }
  assert.equal(ServerMessage.safeParse(change).success, true);
  assert.equal(ServerMessage.safeParse({ ...change, saneYolo: 'true' }).success, false);
});

test('session-prompt carries a validated compaction flag beside the prompt detail', () => {
  const message = { type: 'session-prompt', id: 'session-1', pendingPromptKind: null, pendingPromptDetail: null, isCompacting: true, timestamp: NOW };
  assert.equal(ServerMessage.safeParse(message).success, true);
  assert.equal(ServerMessage.safeParse({ ...message, isCompacting: 'true' }).success, false);
});
