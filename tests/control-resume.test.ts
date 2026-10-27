import test from 'node:test';
import assert from 'node:assert/strict';

import type { GlimmervoidConfig } from '../server/config-store.ts';
import type { ControlMessageRecord } from '../server/core/control-replay-core.ts';
import type { Session } from '../session/sessions.ts';
import { connectControl, controlDeps, createControlServer, testConfigStore } from './helpers/control-harness.ts';
import { STATES } from '../shared/states.ts';
import { plainSession } from './helpers/fake-session.ts';

interface ResumeFrame {
  type: string;
  id?: string;
  ok?: boolean;
  message?: string;
  resumeSessionId?: string | null;
}

function harness(sessions: Map<string, Session>, config: GlimmervoidConfig) {
  const broadcasts: ControlMessageRecord[] = [];
  const saveCalls: number[] = [];
  const server = createControlServer(controlDeps(config, {
    sessions,
    configStore: testConfigStore(config, { onSave: () => saveCalls.push(1) }),
    broadcastControl: (message) => { broadcasts.push(message); },
  }));
  const connection = connectControl<ResumeFrame>(server);
  connection.sent.length = 0;
  return { send: connection.send, sent: connection.sent, broadcasts, saveCalls };
}

test('resume-conversation persists the id, sets it on the session and acks without a session-resume broadcast', () => {
  const s = plainSession('p1');
  const cfg: GlimmervoidConfig = { projects: [{ id: 'p1', name: 'p1', path: 'C:/repo' }] };
  const h = harness(new Map([['p1', s]]), cfg);

  h.send({ type: 'resume-conversation', id: 'p1', conversationId: '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5' });

  assert.equal(cfg.projects[0].resumeSessionId, '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5', 'persisted on project record');
  assert.equal(s.resumeSessionId, '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5', 'set on live session');
  assert.equal(h.broadcasts.some((m) => m.type === 'session-resume'), false);
  const ack = h.sent.find((m) => m.type === 'resume-conversation-ack');
  assert.ok(ack && ack.ok === true, 'acked ok');
});

test('force-restart into an earlier conversation keeps the pick when the old agent reports its own conversation before exiting', () => {
  const runningConversation = '11111111-1111-4111-8111-111111111111';
  const earlierConversation = '22222222-2222-4222-8222-222222222222';
  const s = plainSession('p1');
  s.setResumeConversation(runningConversation);
  s.state = STATES.RUNNING;
  const cfg: GlimmervoidConfig = { projects: [{ id: 'p1', name: 'p1', path: 'C:/repo', resumeSessionId: runningConversation }] };
  const h = harness(new Map([['p1', s]]), cfg);

  h.send({ type: 'force-restart', id: 'p1', conversationId: earlierConversation });
  s.ingestHookSignal({ signal: 'ready', source: 'hook', ts: Date.now(), payload: { session_id: runningConversation } });

  assert.equal(s.resumeSessionId, earlierConversation);
  assert.equal(cfg.projects[0].resumeSessionId, earlierConversation);
});
