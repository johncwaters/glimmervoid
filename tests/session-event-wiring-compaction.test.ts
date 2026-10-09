import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionEventWiring } from '../server/session-event-wiring.ts';
import { NotificationManager } from '../notifications/notification-manager.ts';
import { Session } from '../session/sessions.ts';
import { NOTIFICATION_STATES } from '../shared/notification-states.ts';
import { STATES } from '../shared/states.ts';
import type { NotificationContext } from '../notifications/notification-manager.ts';

const PHONE_ESCALATION_MS = 50;

function wiredSession() {
  const session = new Session({ id: 'compaction-wiring', name: 'compaction-wiring', path: process.cwd(), statusConflictMs: 20, statusDedupMs: 10 });
  session.state = STATES.RUNNING;
  const notificationManager = new NotificationManager({ escalationIntervalMs: 60000, debounceMs: 0, phoneEscalationMs: PHONE_ESCALATION_MS });
  const phoneDeliveries: NotificationContext[] = [];
  notificationManager.registerChannel('web', () => {});
  notificationManager.registerChannel('telegram', (_session, _category, _message, context) => {
    phoneDeliveries.push(context);
  }, { offDashboard: true });
  const config = { projects: [{ id: 'compaction-wiring' } as Record<string, unknown>] };
  const wireSessionEvents = createSessionEventWiring({
    configStore: {
      save: (mutator: (candidate: typeof config) => void) => {
        mutator(config);
        return config;
      },
    },
    config,
    recordLane: () => {},
    usage: { refreshSessions: () => {}, nudgeSession: () => {} },
    broadcastControl: () => {},
    telegramChannel: { noteStateChange: () => {}, recheck: () => {} },
    notificationManager,
    getIngestLane: () => null,
    tapIngestForSession: () => {},
    closeSessionDataClients: () => {},
    logger: { error: () => {}, log: () => {}, warn: () => {} },
  });
  wireSessionEvents(session);
  const phoneEscalations = () => phoneDeliveries.filter((context) => context.phoneEscalation === true);
  return { session, notificationManager, phoneEscalations };
}

const settleEventByState = { [STATES.COMPLETE]: 'task_complete', [STATES.WAITING]: 'prompt_detected' } as const;

for (const settledState of [STATES.COMPLETE, STATES.WAITING] as const) {
  for (const endEvent of ['PostCompact', 'SessionStart'] as const) {
    test(`an idle compaction ended by ${endEvent} keeps the ${settledState} notification escalating`, (t) => {
      t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
      const { session, notificationManager, phoneEscalations } = wiredSession();
      t.after(() => {
        session.destroy();
        notificationManager.destroy();
      });
      session.transition(settleEventByState[settledState], { source: 'hook', signal: 'ready' });
      assert.equal(notificationManager.getNotificationState(session.id), NOTIFICATION_STATES.DELIVERED);

      session._statusSource.ingest({ signal: 'working', source: 'title', ts: Date.now() });
      assert.equal(session.state, STATES.RUNNING);
      session.ingestHookSignal({ signal: 'compaction-start', source: 'hook', ts: Date.now(), event: 'PreCompact', payload: { trigger: 'auto' } });
      const endSignal = endEvent === 'PostCompact' ? 'compaction-end' : 'session-start';
      session.ingestHookSignal({ signal: endSignal, source: 'hook', ts: Date.now(), event: endEvent, payload: { trigger: 'auto', source: 'compact' } });

      assert.equal(session.state, settledState);
      assert.equal(notificationManager.getNotificationState(session.id), NOTIFICATION_STATES.DELIVERED);
      t.mock.timers.tick(PHONE_ESCALATION_MS);
      assert.equal(phoneEscalations().length, 1);
      assert.equal(notificationManager.getNotificationState(session.id), NOTIFICATION_STATES.ESCALATED_PHONE);
    });
  }
}

test('a prompt after an idle title spinner still acknowledges the earlier notification', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { session, notificationManager, phoneEscalations } = wiredSession();
  t.after(() => {
    session.destroy();
    notificationManager.destroy();
  });
  session.transition('task_complete', { source: 'hook', signal: 'ready' });
  session._statusSource.ingest({ signal: 'working', source: 'title', ts: Date.now() });
  assert.equal(notificationManager.getNotificationState(session.id), NOTIFICATION_STATES.DELIVERED);
  session.ingestHookSignal({ signal: 'resume', source: 'hook', ts: Date.now(), event: 'UserPromptSubmit' });
  assert.equal(notificationManager.getNotificationState(session.id), NOTIFICATION_STATES.IDLE);
  t.mock.timers.tick(PHONE_ESCALATION_MS);
  assert.equal(phoneEscalations().length, 0);
});
