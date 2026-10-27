import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentBoardRow, SessionSnapshot } from '../shared/contracts/session.ts';
import { Session } from '../session/sessions.ts';
test('SessionSnapshot shape matches a real Session.toSnapshot output', () => {
  const session = new Session({ id: 'snapshot-drift', name: 'snapshot', path: process.cwd() });
  try {
    assert.deepEqual(Object.keys(session.toSnapshot()).sort(), Object.keys(SessionSnapshot.shape).sort());
  } finally {
    session.destroy();
  }
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
