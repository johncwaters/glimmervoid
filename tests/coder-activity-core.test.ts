import assert from 'node:assert/strict';
import test from 'node:test';
import { Config, CONFIG_BLOCK_KEYS } from '../shared/contracts/config.ts';
import { buildCoderActivityMessage, CODER_ACTIVITY_HEARTBEAT_MS, coderActivityShouldStart, decideCoderReport } from '../server/core/coder-activity-core.ts';
import type { CoderActivityLastReport, CoderActivityState } from '../server/core/coder-activity-core.ts';

const decisions: { name: string; runningSessionCount: number; lastReport: CoderActivityLastReport | null; now: number; expected: CoderActivityState | null }[] = [
  { name: 'first running session reports working', runningSessionCount: 1, lastReport: null, now: 0, expected: 'working' },
  { name: 'working heartbeat waits until due', runningSessionCount: 2, lastReport: { state: 'working', at: 0 }, now: CODER_ACTIVITY_HEARTBEAT_MS - 1, expected: null },
  { name: 'working heartbeat reports when due', runningSessionCount: 2, lastReport: { state: 'working', at: 0 }, now: CODER_ACTIVITY_HEARTBEAT_MS, expected: 'working' },
  { name: 'running after idle reports working immediately', runningSessionCount: 1, lastReport: { state: 'idle', at: 0 }, now: 1, expected: 'working' },
  { name: 'idle reports once after working', runningSessionCount: 0, lastReport: { state: 'working', at: 0 }, now: 1, expected: 'idle' },
  { name: 'idle remains silent with no running sessions', runningSessionCount: 0, lastReport: { state: 'idle', at: 0 }, now: CODER_ACTIVITY_HEARTBEAT_MS, expected: null },
  { name: 'never reported closes a possibly stale working status with idle', runningSessionCount: 0, lastReport: null, now: 0, expected: 'idle' },
];
for (const decision of decisions) {
  test(decision.name, () => assert.equal(decideCoderReport(decision), decision.expected));
}

test('unset and blank slugs silently disable the lane', () => {
  assert.deepEqual(coderActivityShouldStart({}), { start: false });
  assert.deepEqual(coderActivityShouldStart({ appSlug: ' \t ' }), { start: false });
});

test('a configured slug names the missing agent URL', () => {
  assert.deepEqual(coderActivityShouldStart({ appSlug: 'glimmervoid', agentToken: 'secret' }), { start: false, reason: 'Missing CODER_AGENT_URL' });
});

test('a configured slug names missing token sources', () => {
  assert.deepEqual(coderActivityShouldStart({ appSlug: 'glimmervoid', agentUrl: 'http://localhost' }), { start: false, reason: 'Missing CODER_AGENT_TOKEN or CODER_AGENT_TOKEN_FILE' });
});

test('either token source enables a configured lane', () => {
  const configured = { appSlug: 'glimmervoid', agentUrl: 'http://localhost' };
  assert.deepEqual(coderActivityShouldStart({ ...configured, agentToken: 'secret' }), { start: true });
  assert.deepEqual(coderActivityShouldStart({ ...configured, agentTokenFile: '/token' }), { start: true });
});

test('activity messages pluralize the running session count', () => {
  assert.equal(buildCoderActivityMessage(0), 'No Glimmervoid sessions running');
  assert.equal(buildCoderActivityMessage(1), '1 Glimmervoid session running');
  assert.equal(buildCoderActivityMessage(3), '3 Glimmervoid sessions running');
});

test('coder config validates its slug and preserves loose block fields', () => {
  assert.deepEqual(Config.parse({ projects: [], coder: { appSlug: 'glimmervoid', futureSetting: true } }).coder, { appSlug: 'glimmervoid', futureSetting: true });
  assert.equal(Config.safeParse({ projects: [], coder: { appSlug: 42 } }).success, false);
  assert.equal(CONFIG_BLOCK_KEYS.includes('coder'), true);
});
