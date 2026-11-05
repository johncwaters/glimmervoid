import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseRecording, replayDetection } from '../detection/replay.ts';
import { BUILT_IN_AGENTS } from '../session/adapters/index.ts';
import { BUILTIN_AGENT_IDS } from '../shared/contracts/config.ts';

const FIXTURE_DIRECTORY = path.join(import.meta.dirname, 'fixtures');
const FAST = { stabilizationMs: 40, conflictWindowMs: 20, dedupWindowMs: 10 };
const HOOKED_TIERS: ReadonlySet<string> = new Set(['first-class', 'hooked']);
const hookedAgents = BUILT_IN_AGENTS.filter(({ tier }) => HOOKED_TIERS.has(tier));

function fixturesOf(agentId: string): string[] {
  const agentPrefix = `v2-${agentId}-`;
  return fs.readdirSync(FIXTURE_DIRECTORY).filter((name) => name.startsWith(agentPrefix) && name.endsWith('.jsonl'))
    .filter((name) => parseRecording(fs.readFileSync(path.join(FIXTURE_DIRECTORY, name), 'utf8')).agent === agentId);
}

test('every built-in agent id is declared in BUILTIN_AGENT_IDS, so config and telemetry accept it', () => {
  const catalogIds = BUILT_IN_AGENTS.map(({ adapter }) => adapter.id);
  for (const agentId of catalogIds) {
    assert.ok(BUILTIN_AGENT_IDS.some((declaredId) => declaredId === agentId), `${agentId}: add it to BUILTIN_AGENT_IDS in shared/contracts/config.ts`);
  }
  for (const declaredId of BUILTIN_AGENT_IDS) {
    assert.ok(catalogIds.includes(declaredId), `${declaredId}: remove it from BUILTIN_AGENT_IDS or add its BUILT_IN_AGENTS row`);
  }
});

for (const { adapter, tier } of hookedAgents) {
  test(`${adapter.id} (${tier}) carries its hooks and replays a live fixture to ready${adapter.capabilities.awaitingInput ? ' and awaiting-input' : ''}`, async () => {
    assert.ok(adapter.capabilities.hooks && adapter.hooks?.injection, `${adapter.id}: a ${tier} agent needs capabilities.hooks and a hooks.injection`);
    const fixtures = fixturesOf(adapter.id);
    assert.ok(fixtures.length > 0, `${adapter.id}: capture a live fixture with node harness/probe-agent-session.ts ${adapter.id} --write-fixtures`);
    const hookSignals = new Set<string>();
    for (const fixture of fixtures) {
      const { records } = parseRecording(fs.readFileSync(path.join(FIXTURE_DIRECTORY, fixture), 'utf8'));
      const { signals } = await replayDetection(records, { ...FAST, agent: adapter.id });
      for (const signal of signals) if (signal.source === 'hook') hookSignals.add(signal.signal);
    }
    assert.ok(hookSignals.has('ready'), `${adapter.id}: no fixture reaches ready through a hook; map its turn-end event in mapHookToSignal`);
    if (adapter.capabilities.awaitingInput) assert.ok(hookSignals.has('awaiting-input'), `${adapter.id}: no fixture reaches awaiting-input through a hook; map its permission event or set capabilities.awaitingInput false`);
  });
}
