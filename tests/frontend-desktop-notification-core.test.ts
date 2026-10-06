import test from 'node:test';
import assert from 'node:assert/strict';

import { desktopNotificationOptions } from '../public/desktop-notification-core.ts';

test('desktop notifications are silent so the dashboard alert sound is the only sound', () => {
  assert.equal(desktopNotificationOptions('session-1', 'complete', 'done').silent, true);
});

test('desktop notifications keep a per-session per-category tag and fall back to a default body', () => {
  const options = desktopNotificationOptions('session-1', 'waiting', '');
  assert.equal(options.tag, 'glimmervoid-session-1-waiting');
  assert.equal(options.body, 'Session needs attention');
});
