import test from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

import { NotificationManager } from '../notifications/notification-manager.ts';
import { NOTIFICATION_STATES as NS, NOTIFICATION_TRANSITIONS } from '../shared/notification-states.ts';
import { createTelegramChannel, decideTelegramNotification } from '../notifications/channels/telegram.ts';
import { createTelegramCompletionDefer } from '../notifications/telegram-completion-defer.ts';
import type { NotificationContext } from '../notifications/notification-manager.ts';
import { createBackendNotifications } from '../server/backend-notifications.ts';
import type { NotificationConfig } from '../server/backend-notifications.ts';
import { plainSession } from './helpers/fake-session.ts';

interface RecordedDelivery {
  session: string;
  category: string;
  message: string;
  context: NotificationContext;
}

const PHONE_MS = 50;

const QUIET_MS = PHONE_MS * 20;

function makeManager({ withPhoneChannel = true, phoneEscalationMs = PHONE_MS } = {}) {
  const manager = new NotificationManager({ escalationIntervalMs: 60000, debounceMs: 0, phoneEscalationMs });
  const browser: RecordedDelivery[] = [];
  const phone: RecordedDelivery[] = [];
  manager.registerChannel('web', (session, category, message, context) => {
    browser.push({ session, category, message, context });
  });
  if (withPhoneChannel) {
    manager.registerChannel('telegram', (session, category, message, context) => {
      phone.push({ session, category, message, context });
    }, { offDashboard: true });
  }

  const escalations = () => phone.filter((delivery) => delivery.context.phoneEscalation === true);
  return { manager, browser, phone, escalations };
}

const useFakeClock = (t: TestContext) => t.mock.timers.enable({ apis: ['setTimeout'] });

test('the ladder is explicit in the transition table', () => {
  assert.equal(NOTIFICATION_TRANSITIONS[NS.DELIVERED].phone_escalation, NS.ESCALATED_PHONE);
  assert.equal(NOTIFICATION_TRANSITIONS[NS.ESCALATED].phone_escalation, NS.ESCALATED_PHONE);
  assert.equal(NOTIFICATION_TRANSITIONS[NS.ESCALATED_PHONE].acknowledge, NS.ACKNOWLEDGED);
  assert.equal(NOTIFICATION_TRANSITIONS[NS.ESCALATED_PHONE].trigger, NS.PENDING);
  assert.equal(NOTIFICATION_TRANSITIONS[NS.ESCALATED_PHONE].session_destroyed, NS.IDLE);
  assert.equal(
    NOTIFICATION_TRANSITIONS[NS.ESCALATED_PHONE].phone_escalation, undefined,
    'the rung fires once per entry, so there is no edge back to itself'
  );
});

test('an unacknowledged completion reaches the phone, and only the phone', (t) => {
  useFakeClock(t);
  const { manager, browser, escalations } = makeManager();
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'complete', 'build finished');
  assert.equal(browser.length, 1, 'the browser notification is best-effort and immediate');

  t.mock.timers.tick(PHONE_MS - 1);
  assert.equal(escalations().length, 0, 'the phone rung has not come due yet');

  t.mock.timers.tick(1);
  assert.equal(manager.getNotificationState('sess-1'), NS.ESCALATED_PHONE);
  assert.equal(escalations().length, 1);
  assert.equal(browser.length, 1, 're-toasting a browser that already ignored it would just repeat it');
});

test('a suppressed notification reaches the phone after the escalation delay, and only the phone', (t) => {
  useFakeClock(t);
  const { manager, browser, phone } = makeManager();
  t.after(() => manager.destroy());

  manager.setFocusSuppressed(true);
  manager.trigger('sess-1', 'complete', 'build finished');
  t.mock.timers.tick(PHONE_MS);

  assert.equal(browser.length, 0);
  assert.equal(phone.length, 1);
  assert.equal(phone[0].context.phoneEscalation, true);
  assert.equal(manager.getNotificationState('sess-1'), NS.ESCALATED_PHONE);
});

test('blur before the phone delay delivers to the web and no phone ping fires', (t) => {
  useFakeClock(t);
  const { manager, browser, escalations } = makeManager();
  t.after(() => manager.destroy());

  manager.setFocusSuppressed(true);
  manager.trigger('sess-1', 'complete', 'build finished');
  t.mock.timers.tick(PHONE_MS / 2);
  manager.setFocusSuppressed(false);

  assert.equal(browser.length, 1);
  assert.equal(escalations().length, 0);
});

test('an acknowledgement before the rung comes due cancels it', (t) => {
  useFakeClock(t);
  const { manager, escalations } = makeManager();
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'complete', 'build finished');
  manager.acknowledge('sess-1');
  t.mock.timers.tick(QUIET_MS);

  assert.deepEqual(escalations(), [], 'the operator reacted; there is nothing to escalate');
  assert.equal(manager.getNotificationState('sess-1'), NS.IDLE);
});

test('a fresh trigger restarts the ladder rather than inheriting the old entry timer', (t) => {
  useFakeClock(t);
  const { manager, escalations } = makeManager();
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'complete', 'first');
  t.mock.timers.tick(PHONE_MS / 2);
  manager.trigger('sess-1', 'waiting', 'second');

  t.mock.timers.tick(PHONE_MS / 2);
  assert.deepEqual(escalations(), [], 'the replaced entry does not escalate on the new one behalf');

  t.mock.timers.tick(PHONE_MS / 2);
  assert.equal(escalations().length, 1);
  assert.equal(escalations()[0].message, 'second');
});

test('the rung fires once per entry, not once per escalation round', (t) => {
  useFakeClock(t);
  const { manager, escalations } = makeManager();
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'waiting', 'needs input');
  t.mock.timers.tick(PHONE_MS);
  assert.equal(escalations().length, 1);

  manager._transition('sess-1', 'escalation_tick');
  assert.equal(manager.getNotificationState('sess-1'), NS.DELIVERED);
  t.mock.timers.tick(QUIET_MS);
  assert.equal(escalations().length, 1, 'the rung is latched for the life of the entry');
});

test('with no off-dashboard channel registered nothing is armed at all', (t) => {
  useFakeClock(t);
  const { manager, browser } = makeManager({ withPhoneChannel: false });
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'complete', 'build finished');
  t.mock.timers.tick(QUIET_MS);

  assert.equal(browser.length, 1);
  assert.equal(manager.getNotificationState('sess-1'), NS.DELIVERED, 'no rung to climb, so no state change');
});

test('a zero escalation delay switches the ladder off', (t) => {
  useFakeClock(t);
  const { manager, escalations } = makeManager({ phoneEscalationMs: 0 });
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'complete', 'build finished');
  t.mock.timers.tick(QUIET_MS);

  assert.deepEqual(escalations(), []);
  assert.equal(manager.getNotificationState('sess-1'), NS.DELIVERED);
});

test('the escalation bypasses the dashboard-open gate and nothing else', () => {
  const configured = { enabled: true, botToken: 'b', chatId: 'c' };
  assert.deepEqual(
    decideTelegramNotification({ ...configured, connectionCount: 3 }),
    { send: false, reason: 'dashboard-open' }
  );
  assert.deepEqual(
    decideTelegramNotification({ ...configured, connectionCount: 3, phoneEscalation: true }),
    { send: true, reason: 'unacknowledged-escalation' }
  );
  assert.deepEqual(
    decideTelegramNotification({ ...configured, enabled: false, connectionCount: 0, phoneEscalation: true }),
    { send: false, reason: 'disabled' }
  );
  assert.deepEqual(
    decideTelegramNotification({ ...configured, botToken: '', connectionCount: 0, phoneEscalation: true }),
    { send: false, reason: 'not-configured' }
  );
});

test('no timer is armed when the off-dashboard channel would not deliver', (t) => {
  useFakeClock(t);
  const manager = new NotificationManager({ escalationIntervalMs: 60000, debounceMs: 0, phoneEscalationMs: PHONE_MS });
  t.after(() => manager.destroy());
  const phone: RecordedDelivery[] = [];
  let telegramEnabled = false;
  manager.registerChannel('web', () => {});
  manager.registerChannel('telegram', (session, category, message, context) => {
    phone.push({ session, category, message, context });
  }, { offDashboard: true, canEscalate: () => telegramEnabled });

  manager.trigger('sess-1', 'complete', 'build finished');
  t.mock.timers.tick(QUIET_MS);
  assert.equal(manager.getNotificationState('sess-1'), NS.DELIVERED, 'nothing to escalate to');
  assert.equal(phone.filter((d) => d.context.phoneEscalation === true).length, 0);

  telegramEnabled = true;
  manager.trigger('sess-2', 'complete', 'other build finished');
  t.mock.timers.tick(PHONE_MS);
  assert.equal(manager.getNotificationState('sess-2'), NS.ESCALATED_PHONE);
});

test('the escalation timer is unref\'d', (t) => {
  const { manager } = makeManager({ phoneEscalationMs: 60_000 });
  t.after(() => manager.destroy());
  manager.trigger('sess-1', 'complete', 'build finished');
  const entry = manager._entries.get('sess-1');
  assert.ok(entry?.phoneTimer, 'a timer was armed');
  assert.equal(entry.phoneTimer.hasRef(), false, 'and it does not hold the event loop open');
});

test('the ladder delay is configurable through updateSettings', (t) => {
  useFakeClock(t);
  const { manager, escalations } = makeManager({ phoneEscalationMs: 60_000 });
  t.after(() => manager.destroy());
  manager.updateSettings({ phoneEscalationMs: PHONE_MS });
  manager.trigger('sess-1', 'complete', 'build finished');
  t.mock.timers.tick(PHONE_MS);
  assert.equal(escalations().length, 1, 'the new delay is what the next notification arms with');
});

function makeWaitingManager(isDashboardOpen: boolean) {
  const manager = new NotificationManager({ escalationIntervalMs: PHONE_MS, debounceMs: 0, phoneEscalationMs: PHONE_MS });
  const browser: RecordedDelivery[] = [];
  const phonePings: RecordedDelivery[] = [];
  manager.registerChannel('web', (session, category, message, context) => {
    browser.push({ session, category, message, context });
  });
  manager.registerChannel('telegram', (session, category, message, context) => {
    const send = context.phoneEscalation === true || !isDashboardOpen;
    if (send) phonePings.push({ session, category, message, context });
    return { send };
  }, { offDashboard: true });
  return { manager, browser, phonePings };
}

function tickEscalationRounds(t: TestContext, roundCount: number): void {
  for (let round = 0; round < roundCount; round++) t.mock.timers.tick(PHONE_MS);
}

test('a waiting notification left alone with no dashboard pings the phone once while the browser keeps re-toasting', (t) => {
  useFakeClock(t);
  const { manager, browser, phonePings } = makeWaitingManager(false);
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'waiting', 'needs input');
  tickEscalationRounds(t, 6);

  assert.equal(phonePings.length, 1);
  assert.equal(phonePings[0].context.phoneEscalation, undefined);
  assert.equal(browser.length, 7);
});

test('a waiting notification left alone behind an open dashboard pings the phone once, on the rung', (t) => {
  useFakeClock(t);
  const { manager, phonePings } = makeWaitingManager(true);
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'waiting', 'needs input');
  assert.equal(phonePings.length, 0);
  tickEscalationRounds(t, 6);

  assert.equal(phonePings.length, 1);
  assert.equal(phonePings[0].context.phoneEscalation, true);
});

test('a fresh trigger after the phone was reached pings the phone again', (t) => {
  useFakeClock(t);
  const { manager, phonePings } = makeWaitingManager(false);
  t.after(() => manager.destroy());

  manager.trigger('sess-1', 'waiting', 'first question');
  tickEscalationRounds(t, 6);
  manager.trigger('sess-1', 'waiting', 'second question');

  assert.deepEqual(phonePings.map((ping) => ping.message), ['first question', 'second question']);
});

function makeManagerWithProductionTelegram() {
  const manager = new NotificationManager({ escalationIntervalMs: PHONE_MS, debounceMs: 0, phoneEscalationMs: PHONE_MS });
  const deliveredTexts: string[] = [];
  const activeAgents = { count: 0 };
  const telegramChannel = createTelegramCompletionDefer({
    deliver: createTelegramChannel({
      getConfig: () => ({ telegramNotifications: true, telegram: { botToken: 'b', chatId: 'c' } }),
      getConnectionCount: () => 0,
      getActiveAgentCount: () => activeAgents.count,
      outbox: { deliver: async (text) => { deliveredTexts.push(text); } },
    }),
    recheckMs: QUIET_MS * 10,
    onDeferredSend: (sessionId) => manager.markPhoneReached(sessionId),
  });
  manager.registerChannel('web', () => {});
  manager.registerChannel('telegram', telegramChannel, { offDashboard: true });
  return { manager, telegramChannel, deliveredTexts, activeAgents };
}

test('the production telegram channel delivers a waiting notification once across six escalation rounds', (t) => {
  useFakeClock(t);
  const { manager, telegramChannel, deliveredTexts } = makeManagerWithProductionTelegram();
  t.after(() => { telegramChannel.destroy(); manager.destroy(); });

  manager.trigger('sess-1', 'waiting', 'needs input');
  tickEscalationRounds(t, 6);

  assert.deepEqual(deliveredTexts, ['needs input']);
});

test('a completion deferred behind active agents and sent on recheck is not sent again by the phone rung', (t) => {
  useFakeClock(t);
  const { manager, telegramChannel, deliveredTexts, activeAgents } = makeManagerWithProductionTelegram();
  t.after(() => { telegramChannel.destroy(); manager.destroy(); });

  activeAgents.count = 2;
  manager.trigger('sess-1', 'complete', 'build finished');
  assert.deepEqual(deliveredTexts, []);

  activeAgents.count = 0;
  telegramChannel.recheck('sess-1');
  assert.deepEqual(deliveredTexts, ['build finished']);

  t.mock.timers.tick(PHONE_MS);
  assert.deepEqual(deliveredTexts, ['build finished']);
});

test('a completion deferred behind active agents and sent by the recheck timer is not sent again by the phone rung', (t) => {
  useFakeClock(t);
  const { manager, telegramChannel, deliveredTexts, activeAgents } = makeManagerWithProductionTelegram();
  t.after(() => { telegramChannel.destroy(); manager.destroy(); });
  manager.updateSettings({ phoneEscalationMs: QUIET_MS * 20 });

  activeAgents.count = 2;
  manager.trigger('sess-1', 'complete', 'build finished');
  activeAgents.count = 0;
  t.mock.timers.tick(QUIET_MS * 10);
  assert.deepEqual(deliveredTexts, ['build finished']);

  t.mock.timers.tick(QUIET_MS * 20);
  assert.deepEqual(deliveredTexts, ['build finished']);
});

const MAX_EVENT_LOOP_TURNS = 1000;

async function waitUntil(isSettled: () => boolean): Promise<void> {
  for (let turn = 0; turn < MAX_EVENT_LOOP_TURNS; turn += 1) {
    if (isSettled()) return;
    await yieldToEventLoop();
  }
  assert.fail('the backend telegram outbox never settled');
}

function makeBackendNotificationsWithUnreachableNetwork(t: TestContext) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-backend-notifications-'));
  const networkRequest = t.mock.method(https, 'request', () => {
    throw new Error('the network is off limits in tests');
  });
  const config: NotificationConfig = {
    telegramNotifications: true,
    telegram: { botToken: 'b', chatId: 'c' },
    phoneEscalationMs: PHONE_MS,
  };
  const session = plainSession('sess-1');
  const idleSnapshot = session.toSnapshot();
  const activeAgents = { count: 0 };
  t.mock.method(session, 'toSnapshot', () => ({ ...idleSnapshot, activeAgents: activeAgents.count }));
  const noClients = { clients: [], on: () => {} };
  const backendNotifications = createBackendNotifications({
    config,
    configStore: { configPath: path.join(configDir, 'config.json') },
    sessions: new Map([[session.id, session]]),
    controlWss: noClients,
    dataWss: noClients,
    broadcastControl: () => {},
    logger: { warn: () => {} },
  });
  t.after(() => {
    backendNotifications.heartbeat.stop();
    backendNotifications.telegramChannel.destroy();
    backendNotifications.notificationManager.destroy();
    fs.rmSync(configDir, { recursive: true, force: true });
  });
  return { ...backendNotifications, config, activeAgents, networkRequest };
}

test('the backend wiring queues one telegram text for a completion sent on recheck and then left past the phone rung', async (t) => {
  useFakeClock(t);
  const {
    notificationManager, telegramChannel, telegramOutbox, config, activeAgents, networkRequest,
  } = makeBackendNotificationsWithUnreachableNetwork(t);

  activeAgents.count = 2;
  notificationManager.trigger('sess-1', 'complete', 'build finished');
  assert.deepEqual(telegramOutbox.pending(), []);

  activeAgents.count = 0;
  telegramChannel.recheck('sess-1');
  t.mock.timers.tick(PHONE_MS);
  const queuedTexts = telegramOutbox.pending().map((entry) => entry.text);

  config.telegram = null;
  await waitUntil(() => telegramOutbox.isRetryArmed());
  await telegramOutbox.idle();

  assert.deepEqual(queuedTexts, ['build finished']);
  assert.equal(networkRequest.mock.callCount(), 0);
});
