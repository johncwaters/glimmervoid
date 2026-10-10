import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldShowTelemetryNotice } from '../public/telemetry-notice-core.ts';

test('shouldShowTelemetryNotice: shows while telemetry is enabled and the notice was never dismissed', () => {
  assert.equal(shouldShowTelemetryNotice({ telemetry: { enabled: true } }, false), true);
});

test('shouldShowTelemetryNotice: a dismissed notice stays hidden even while telemetry is enabled', () => {
  assert.equal(shouldShowTelemetryNotice({ telemetry: { enabled: true } }, true), false);
});

test('shouldShowTelemetryNotice: telemetry turned off hides the notice', () => {
  assert.equal(shouldShowTelemetryNotice({ telemetry: { enabled: false } }, false), false);
});

test('shouldShowTelemetryNotice: a payload without a boolean true telemetry.enabled fails closed', () => {
  const malformedPayloads = [null, undefined, 'on', {}, { telemetry: null }, { telemetry: {} }, { telemetry: { enabled: 'true' } }, { telemetry: { enabled: 1 } }];
  for (const settings of malformedPayloads) {
    assert.equal(shouldShowTelemetryNotice(settings, false), false, JSON.stringify(settings));
  }
});

test('shouldShowTelemetryNotice: an environment override that forces telemetry off hides the notice', () => {
  assert.equal(shouldShowTelemetryNotice({ telemetry: { enabled: true }, telemetryForcedOff: true }, false), false);
  assert.equal(shouldShowTelemetryNotice({ telemetry: { enabled: true }, telemetryForcedOff: false }, false), true);
});
