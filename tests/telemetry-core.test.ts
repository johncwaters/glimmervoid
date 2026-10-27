import test from 'node:test';
import assert from 'node:assert/strict';

import {decideTelemetryConsent, 
} from '../server/core/telemetry-core.ts';

const CONSENT_PRECEDENCE: Array<{ env: Record<string, string>; enabled?: boolean; expected: { isEnabled: boolean; source: string } }> = [
  { env: {}, expected: { isEnabled: true, source: 'default' } },
  { env: {}, enabled: true, expected: { isEnabled: true, source: 'config' } },
  { env: {}, enabled: false, expected: { isEnabled: false, source: 'config' } },
  { env: { DO_NOT_TRACK: '1' }, enabled: true, expected: { isEnabled: false, source: 'do-not-track' } },
  { env: { GLIMMERVOID_TELEMETRY: '0' }, enabled: true, expected: { isEnabled: false, source: 'environment' } },
  { env: { CI: 'true' }, enabled: true, expected: { isEnabled: false, source: 'ci' } },
  { env: { NODE_TEST_CONTEXT: 'child-v8' }, enabled: true, expected: { isEnabled: false, source: 'test-runner' } },
  { env: { NODE_TEST_CONTEXT: 'child-v8' }, expected: { isEnabled: false, source: 'test-runner' } },
  { env: { CI: 'true', NODE_TEST_CONTEXT: 'child-v8' }, enabled: true, expected: { isEnabled: false, source: 'ci' } },
  { env: { DO_NOT_TRACK: '1', GLIMMERVOID_TELEMETRY: '0', CI: 'true' }, enabled: true, expected: { isEnabled: false, source: 'do-not-track' } },
  { env: { GLIMMERVOID_TELEMETRY: '0', CI: 'true' }, expected: { isEnabled: false, source: 'environment' } },
  { env: { DO_NOT_TRACK: '0', GLIMMERVOID_TELEMETRY: '1', CI: 'false' }, expected: { isEnabled: true, source: 'default' } },
  { env: { GLIMMERVOID_TELEMETRY: '1' }, enabled: false, expected: { isEnabled: false, source: 'config' } },
];

test('consent follows DO_NOT_TRACK, then GLIMMERVOID_TELEMETRY, then CI, then config, then on by default', () => {
  for (const row of CONSENT_PRECEDENCE) {
    const config = row.enabled === undefined ? {} : { telemetry: { enabled: row.enabled } };
    assert.deepEqual(decideTelemetryConsent(row.env, config), row.expected, JSON.stringify(row));
  }
});
