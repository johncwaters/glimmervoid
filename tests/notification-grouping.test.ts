import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { NotificationManager } from '../notifications/notification-manager.ts';
import type { NotificationContext } from '../notifications/notification-manager.ts';

interface ChannelCall {
  sessionId: string;
  category: string;
  context: NotificationContext;
}

function createManagerWithChannels({ nowMs, phoneEscalationMs }: { nowMs: () => number; phoneEscalationMs: number }) {
  const notificationManager = new NotificationManager({ alertGroupWindowMs: 3000, phoneEscalationMs, now: nowMs });
  const dashboardCalls: ChannelCall[] = [];
  const phoneCalls: ChannelCall[] = [];
  notificationManager.registerChannel('web', (sessionId, category, _message, context) => {
    dashboardCalls.push({ sessionId, category, context });
    return undefined;
  });
  notificationManager.registerChannel('telegram', (sessionId, category, _message, context) => {
    phoneCalls.push({ sessionId, category, context });
    return { send: true };
  }, { offDashboard: true });
  return { notificationManager, dashboardCalls, phoneCalls };
}

test('alerts from different sessions within the window share one group and never reach the phone channel on first delivery', () => {
  let nowMs = 1_000;
  const { notificationManager, dashboardCalls, phoneCalls } = createManagerWithChannels({ nowMs: () => nowMs, phoneEscalationMs: 0 });

  notificationManager.trigger('api', 'waiting', 'api needs input');
  nowMs += 1_200;
  notificationManager.trigger('web', 'complete', 'web finished working');
  nowMs += 2_000;
  notificationManager.trigger('db', 'failed', 'db failed');

  assert.deepEqual(dashboardCalls.map(({ sessionId, context }) => [sessionId, context.group]), [
    ['api', { id: 1, isStart: true, sessionIds: ['api'] }],
    ['web', { id: 1, isStart: false, sessionIds: ['api', 'web'] }],
    ['db', { id: 2, isStart: true, sessionIds: ['db'] }],
  ]);
  assert.equal(phoneCalls.length, 0);
  notificationManager.destroy();
});

test('the phone channel hears about an alert only once it has sat unacknowledged for the escalation delay', async () => {
  const { notificationManager, phoneCalls } = createManagerWithChannels({ nowMs: () => Date.now(), phoneEscalationMs: 20 });

  notificationManager.trigger('api', 'waiting', 'api needs input');
  assert.equal(phoneCalls.length, 0);
  await delay(60);

  assert.deepEqual(phoneCalls.map(({ sessionId, context }) => [sessionId, context.phoneEscalation]), [['api', true]]);
  notificationManager.destroy();
});

test('a seen reply before the escalation delay keeps the alert off the phone channel', async () => {
  const { notificationManager, dashboardCalls, phoneCalls } = createManagerWithChannels({ nowMs: () => Date.now(), phoneEscalationMs: 20 });

  notificationManager.trigger('api', 'waiting', 'api needs input');
  notificationManager.acknowledge('api');
  await delay(60);

  assert.deepEqual(dashboardCalls.map(({ sessionId }) => sessionId), ['api']);
  assert.equal(phoneCalls.length, 0);
  notificationManager.destroy();
});
