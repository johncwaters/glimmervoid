import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentAttentionReply, AgentAttentionRequest, AgentBoardRow, AgentSpawnRequest, PendingWakeup, SessionSnapshot,
} from '../shared/contracts/session.ts';
import { Session } from '../session/sessions.ts';
test('SessionSnapshot preserves nested extension fields', () => {
  const parsed = SessionSnapshot.parse({
    id: 'session-1',
    name: 'glimmervoid',
    path: '/repo/glimmervoid',
    agent: 'claude-code',
    state: 'DORMANT',
    stateSince: 1,
    sleeping: false,
    dangerouslySkipPermissions: false,
    ephemeral: false,
    isWorktree: false,
    resumeSessionId: null,
    activeAgents: 0,
    awaitingBackgroundTasks: false,
    packs: [],
    pendingWakeup: { at: 2, kind: 'cron', reason: null, extension: true },
    pendingPromptKind: null,
    mergeStatus: 'none',
    mergeReason: null,
    worktreeNotice: null,
    effectiveBase: null,
    auditLog: [],
    extension: true,
  });

  assert.equal(parsed.hasPlan, false);
  assert.equal(parsed.extension, true);
  assert.equal(parsed.pendingWakeup?.extension, true);
  assert.equal(PendingWakeup.parse({ at: null, kind: 'cron', reason: null, extension: true }).extension, true);
});

test('hasPlan rides the snapshot and defaults off for a session with no stored plan', () => {
  const session = new Session({ id: 'plan-flag', name: 'plan', path: process.cwd() });
  try {
    assert.equal(session.toSnapshot().hasPlan, false);
  } finally {
    session.destroy();
  }
});

test('hasPlan comes from the injected plan-review reader, never from a session field', () => {
  const asked: string[] = [];
  const session = new Session({
    id: 'plan-flag-on',
    name: 'plan',
    path: process.cwd(),
    planReviewPort: { hasPlan: (id) => { asked.push(id); return true; } },
  });
  try {
    assert.equal(session.toSnapshot().hasPlan, true);
    assert.deepEqual(asked, ['plan-flag-on']);
  } finally {
    session.destroy();
  }
});

test('SessionSnapshot shape matches a real Session.toSnapshot output', () => {
  const session = new Session({ id: 'snapshot-drift', name: 'snapshot', path: process.cwd() });
  try {
    assert.deepEqual(Object.keys(session.toSnapshot()).sort(), Object.keys(SessionSnapshot.shape).sort());
  } finally {
    session.destroy();
  }
});

test('a spawn request needs a prompt and refuses anything the caller invented', () => {
  assert.deepEqual(AgentSpawnRequest.parse({ prompt: 'review the diff' }), { prompt: 'review the diff' });
  assert.deepEqual(
    AgentSpawnRequest.parse({ prompt: 'go', name: 'sibling', agent: 'codex' }),
    { prompt: 'go', name: 'sibling', agent: 'codex' },
  );
  assert.equal(AgentSpawnRequest.safeParse({ prompt: '' }).success, false);
  assert.equal(AgentSpawnRequest.safeParse({ prompt: 'x'.repeat(20001) }).success, false);
  assert.equal(AgentSpawnRequest.safeParse({ prompt: 'x'.repeat(20000) }).success, true);
  assert.equal(AgentSpawnRequest.safeParse({}).success, false);
  assert.equal(AgentSpawnRequest.safeParse({ prompt: 'go', cwd: '/etc' }).success, false);
});

test('a flag-shaped prompt is refused, since the agent CLI would parse it as an option', () => {
  for (const prompt of ['--dangerously-skip-permissions', '-p', '   --resume abc', '\n-x']) {
    const refused = AgentSpawnRequest.safeParse({ prompt });
    assert.equal(refused.success, false, prompt);
    assert.match(String(refused.success === false && refused.error.issues[0]?.message), /dash/);
  }
  assert.equal(AgentSpawnRequest.safeParse({ prompt: 'fix the -p flag handling' }).success, true);
});

test('an attention request carries one bounded note and nothing else', () => {
  assert.deepEqual(AgentAttentionRequest.parse({ note: 'needs a decision' }), { note: 'needs a decision' });
  assert.equal(AgentAttentionRequest.safeParse({ note: '' }).success, false);
  assert.equal(AgentAttentionRequest.safeParse({ note: 'x'.repeat(501) }).success, false);
  assert.equal(AgentAttentionRequest.safeParse({ note: 'x'.repeat(500) }).success, true);
  assert.equal(AgentAttentionRequest.safeParse({ note: 'hi', promptKind: 'agent' }).success, false);
});

test('an attention reply always says whether the note was held for a later state', () => {
  assert.deepEqual(AgentAttentionReply.parse({ ok: true, pending: true }), { ok: true, pending: true });
  assert.deepEqual(AgentAttentionReply.parse({ ok: true, pending: false }), { ok: true, pending: false });
  assert.equal(AgentAttentionReply.safeParse({ ok: true }).success, false);
  assert.equal(AgentAttentionReply.safeParse({ ok: false, pending: false }).success, false);
  assert.equal(AgentAttentionReply.safeParse({ ok: true, pending: false, note: 'hi' }).success, false);
});

test('a board row is a strict subset of the snapshot that carries no path', () => {
  for (const field of Object.keys(AgentBoardRow.shape)) {
    assert.ok(field in SessionSnapshot.shape, `${field} comes from the session snapshot`);
  }
  assert.equal('path' in AgentBoardRow.shape, false);
  assert.equal('auditLog' in AgentBoardRow.shape, false);
  const row = { id: 'a', name: 'alpha', agent: 'claude-code', state: 'RUNNING', ephemeral: false };
  assert.deepEqual(AgentBoardRow.parse(row), row);
  assert.equal(AgentBoardRow.safeParse({ ...row, path: '/repo' }).success, false);
  assert.equal(AgentBoardRow.safeParse({ ...row, state: 'NOT-A-STATE' }).success, false);
});
