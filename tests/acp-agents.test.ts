import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { Config } from '../shared/contracts/config.ts';
import {
  BUILT_IN_ACP_AGENTS,
  buildAcpAgentTable,
  describeAcpAgentResolvability,
  resolveAcpAgentLaunch,
} from '../session/drivers/acp-agents.ts';
import type { AcpAgentEntry, AcpAgentLaunchResult, AcpAgentResolvability, AcpAgentTableResult, AcpCommandProbeOptions } from '../session/drivers/acp-agents.ts';

test('ACP agent table resolves built-in and config rows to launch commands and fails closed on invalid or colliding rows', () => {
  assert.deepEqual(
    BUILT_IN_ACP_AGENTS.map((entry: AcpAgentEntry) => ({ id: entry.id, command: entry.command, args: entry.args })),
    [
      { id: 'claude-code', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp@0.112.0'] },
      { id: 'codex', command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp@2.12.0'] },
      { id: 'antigravity', command: 'agy', args: ['acp'] },
    ],
  );

  const parsedConfig = Config.parse({
    projects: [],
    acpAgents: [
      { id: 'my-acp', label: 'My ACP', command: 'my-acp-bin', args: ['--stdio'] },
    ],
  });

  const table: AcpAgentTableResult = buildAcpAgentTable(parsedConfig.acpAgents);
  assert.equal(table.ok, true);
  assert.deepEqual(table.entries.map((entry) => entry.id), ['claude-code', 'codex', 'antigravity', 'my-acp']);

  const claudeLaunch: AcpAgentLaunchResult = resolveAcpAgentLaunch('claude-code', parsedConfig.acpAgents);
  assert.equal(claudeLaunch.ok, true);
  assert.equal(claudeLaunch.file, 'npx');
  assert.deepEqual(claudeLaunch.args, ['-y', '@agentclientprotocol/claude-agent-acp@0.112.0']);

  const customLaunch = resolveAcpAgentLaunch('my-acp', parsedConfig.acpAgents);
  assert.equal(customLaunch.ok, true);
  assert.equal(customLaunch.file, 'my-acp-bin');
  assert.deepEqual(customLaunch.args, ['--stdio']);

  const unknownLaunch = resolveAcpAgentLaunch('nonexistent', parsedConfig.acpAgents);
  assert.equal(unknownLaunch.ok, false);

  const probeOptions: AcpCommandProbeOptions = {
    platform: 'linux',
    execFile: (file, args) => {
      if (file === 'which' && args[1] === 'npx') return '/usr/bin/npx\n';
      throw new Error('not found');
    },
    pathExists: () => false,
  };
  const claudeProbe: AcpAgentResolvability = describeAcpAgentResolvability(table.entries[0], probeOptions);
  assert.equal(claudeProbe.resolvable, true);
  assert.match(claudeProbe.doctorValue, /\/usr\/bin\/npx \(via npx; @agentclientprotocol\/claude-agent-acp@0\.112\.0 not downloaded\)/);

  const missingCustomProbe = describeAcpAgentResolvability(table.entries[3], probeOptions);
  assert.equal(missingCustomProbe.resolvable, false);
  assert.equal(missingCustomProbe.doctorValue, 'not found on PATH');

  for (const invalidRows of [
    [{ id: 'claude-code', label: 'Shadow', command: 'claude-acp', args: [] }],
    [{ id: 'codex', label: 'Shadow', command: 'codex-acp', args: [] }],
    [{ id: 'antigravity', label: 'Shadow', command: 'agy', args: ['acp'] }],
    [
      { id: 'dup-acp', label: 'One', command: 'one-acp', args: [] },
      { id: 'dup-acp', label: 'Two', command: 'two-acp', args: [] },
    ],
    [{ id: 'bad-cmd', label: 'Shell', command: 'sh -c evil', args: [] }],
    [{ id: 'dot-cmd', label: 'Dot', command: '.', args: [] }],
    [{ id: 'dotdot-cmd', label: 'DotDot', command: '..', args: [] }],
    [{ id: 'nul-arg', label: 'Nul', command: 'good-bin', args: ['--flag', 'bad\0arg'] }],
    [{ id: 'extra-key', label: 'Extra', command: 'good-bin', args: [], shell: true }],
  ]) {
    assert.equal(Config.safeParse({ projects: [], acpAgents: invalidRows }).success, false);
    assert.equal(resolveAcpAgentLaunch('claude-code', invalidRows).ok, false);
  }
});
