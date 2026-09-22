import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionEventWiring } from '../server/session-event-wiring.ts';
import { plainSession } from './helpers/fake-session.ts';

function wiredSession() {
  const session = plainSession('resume-persist-session');
  const recordedLanes: string[] = [];
  const config = { projects: [{ id: 'resume-persist-session' } as Record<string, unknown>] };
  const wireSessionEvents = createSessionEventWiring({
    configStore: {
      save: (mutator: (candidate: typeof config) => void) => {
        mutator(config);
        return config;
      },
    },
    config,
    recordLane: (claudeSessionId: string) => { recordedLanes.push(claudeSessionId); },
    usage: { refreshSessions: () => {}, nudgeSession: () => {} },
    broadcastControl: () => {},
    telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
    notificationManager: { acknowledge: () => {}, trigger: () => {} },
    getIngestLane: () => null,
    tapIngestForSession: () => {},
    closeSessionDataClients: () => {},
    logger: { error: () => {}, log: () => {}, warn: () => {} },
  });
  const savedField = () => config.projects[0]?.resumeSessionId ?? null;
  wireSessionEvents(session);
  return { session, recordedLanes, savedField };
}

test('a live id that is not the resume target is never written to config', () => {
  const { session, recordedLanes, savedField } = wiredSession();
  session.emit('claude-session-id', {
    id: 'bbbb2222-0000-0000-0000-bbbbbbbbbbbb',
    vendor: 'claude',
    isResumeTarget: false,
  });
  assert.equal(savedField(), null, 'a blank spawn cannot overwrite a saved conversation');
  assert.deepEqual(recordedLanes, ['bbbb2222-0000-0000-0000-bbbbbbbbbbbb'], 'usage attribution still follows the live id');
  session.destroy();
});

test('a live id that is the resume target is written to config', () => {
  const { session, recordedLanes, savedField } = wiredSession();
  session.emit('claude-session-id', {
    id: 'aaaa1111-0000-0000-0000-aaaaaaaaaaaa',
    vendor: 'claude',
    isResumeTarget: true,
  });
  assert.equal(savedField(), 'aaaa1111-0000-0000-0000-aaaaaaaaaaaa');
  assert.deepEqual(recordedLanes, ['aaaa1111-0000-0000-0000-aaaaaaaaaaaa']);
  session.destroy();
});
