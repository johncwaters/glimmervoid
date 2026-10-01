import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionEventWiring } from '../server/session-event-wiring.ts';
import { plainSession } from './helpers/fake-session.ts';

function wiredSession() {
  const session = plainSession('telemetry-session', 'secret-project-name');
  const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const config = { projects: [{ id: 'telemetry-session' } as Record<string, unknown>] };
  const wireSessionEvents = createSessionEventWiring({
    configStore: { save: () => config },
    config,
    recordLane: () => {},
    usage: { refreshSessions: () => {}, nudgeSession: () => {} },
    broadcastControl: () => {},
    telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
    notificationManager: { acknowledge: () => {}, trigger: () => {} },
    getIngestLane: () => null,
    tapIngestForSession: () => {},
    closeSessionDataClients: () => {},
    telemetry: { capture: (event, properties) => { captured.push({ event, properties }); } },
    logger: { error: () => {}, log: () => {}, warn: () => {} },
  });
  wireSessionEvents(session);
  return { session, captured };
}

test('a spawn and its exit report the adapter, exit kind and duration and nothing naming the session', () => {
  const { session, captured } = wiredSession();
  session.emit('state-change', { from: 'idle', to: 'starting', event: 'spawn_success', detail: null });
  session.emit('exit', { exitCode: 0, signal: 0 });
  assert.deepEqual(captured, [
    { event: 'session_started', properties: { adapter: session.agentId } },
    { event: 'session_ended', properties: { adapter: session.agentId, exit_kind: 'clean', duration_seconds: 0 } },
  ]);
  assert.equal(JSON.stringify(captured).includes('secret-project-name'), false);
  session.destroy();
});

test('an exit with no recorded spawn reports nothing', () => {
  const { session, captured } = wiredSession();
  session.emit('exit', { exitCode: 1, signal: 0 });
  assert.deepEqual(captured, []);
  session.destroy();
});
