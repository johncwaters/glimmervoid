import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../session/sessions.ts';
import { SessionRecorder } from '../session/session-recorder.ts';
import { HookRouter } from '../detection/hook-source.ts';
import claudeCode from '../session/adapters/claude-code.ts';
import { capturingPty, fakePty } from './helpers/fake-pty.ts';
import kimi from '../session/adapters/kimi.ts';
import type { AgentAdapter, AgentCapabilities } from '../session/adapters/index.ts';
import type { SessionOptions } from '../session/sessions.ts';

interface HookSettingsFile {
  statusLine?: { type?: string };
  hooks: Record<string, unknown>;
}

interface CapabilitySpawnCall {
  file: string;
  args: string[];
  env: Record<string, string | undefined>;
}

function agentWithout(...disabled: (keyof AgentCapabilities)[]): AgentAdapter {
  const capabilities: AgentCapabilities = { ...claudeCode.capabilities };
  for (const capability of disabled) capabilities[capability] = false;
  return { ...claudeCode, id: 'test-agent', label: 'Test Agent', capabilities };
}

function makeSession(options: Partial<SessionOptions> & { id: string; name: string }) {
  const calls: CapabilitySpawnCall[] = [];
  const session = new Session({
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args, opts) => { calls.push({ file, args, env: opts.env ?? {} }); return fakePty(); },
    ...options,
  });
  return { session, calls };
}

async function withHooks(
  options: Partial<SessionOptions> & { id: string; name: string },
  run: (context: { session: Session; settings: HookSettingsFile; calls: CapabilitySpawnCall[] }) => void,
) {
  const hooksBaseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-cap-hooks-'));
  const { session, calls } = makeSession({
    hookRouter: new HookRouter(),
    getHookPort: () => 41234,
    hooksBaseDir,
    ...options,
  });
  try {
    await session.start();
    const settings = JSON.parse(fs.readFileSync(path.join(hooksBaseDir, options.id, 'settings.json'), 'utf8')) as HookSettingsFile;
    await run({ session, calls, settings });
  } finally {
    session.destroy();
    await fsp.rm(hooksBaseDir, { recursive: true, force: true });
  }
}

test('backgroundAgents off: subagent signals never gate a completion', async () => {
  const { session } = makeSession({ id: 'gate', name: 'gate', adapter: agentWithout('backgroundAgents') });
  try {
    session.ingestHookSignal({ signal: 'subagent-start', source: 'hook', ts: 1000, event: 'SubagentStart', payload: { agent_id: 'a1' } });
    session.ingestHookSignal({ signal: 'ready', source: 'hook', ts: 1100, event: 'Stop', payload: { background_tasks: [{ id: 't1', type: 'teammate', status: 'running' }] } });
    assert.equal(session.toSnapshot().activeAgents, 0);
  } finally {
    session.destroy();
  }
});

test('an artifact comment watch is not background work, any other running monitor is', () => {
  const artifactCommentWatch = {
    id: 'sqf8sk1te',
    type: 'monitor',
    status: 'running',
    description: 'live updates for artifact https://claude.ai/artifact/exampleArtifactId (watch requested)',
  };
  const mcpMonitor = { id: 'm1', type: 'monitor', status: 'running', description: 'deploy log stream' };
  const { session } = makeSession({ id: 'watch', name: 'watch' });
  try {
    session.ingestHookSignal({ signal: 'ready', source: 'hook', ts: Date.now(), event: 'Stop', payload: { background_tasks: [artifactCommentWatch] } });
    assert.equal(session.hasBackgroundWork, false);
    session.ingestHookSignal({ signal: 'ready', source: 'hook', ts: Date.now(), event: 'Stop', payload: { background_tasks: [artifactCommentWatch, mcpMonitor] } });
    assert.equal(session.hasBackgroundWork, true);
  } finally {
    session.destroy();
  }
});

test('a claude-code recording differs only by the header agent field', async () => {
  const recorderBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-cap-rec-'));
  const { session } = makeSession({ id: 'rec', name: 'rec' });
  const recorder = new SessionRecorder({ name: 'rec', baseDir: recorderBase, recordData: false });
  session.setRecorder(recorder);
  try {
    await session.start();
    session.ingestHookSignal({ signal: 'ready', source: 'hook', ts: 1000, event: 'Stop', payload: {} });
    recorder.writeFooter('pty_exit', 0);
    await new Promise<void>((resolve) => { recorder._stream?.once('finish', () => resolve()); recorder.close(); });
    const file = fs.readdirSync(recorderBase).find((entry) => entry.endsWith('.jsonl'));
    const records = fs.readFileSync(path.join(recorderBase, String(file)), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

    const header = records.find((r) => r.type === 'header');
    assert.deepEqual(Object.keys(header ?? {}).sort(), ['agent', 'cols', 'config', 'records', 'rows', 'session', 'startedAt', 'type', 'version']);
    assert.equal(header?.agent, 'claude-code');
    assert.deepEqual(Object.keys((header?.config ?? {}) as Record<string, unknown>).sort(), ['cols', 'hooksInjected', 'rows'], 'the agent rides the header, not the config bag');
    for (const record of records.filter((r) => r.type !== 'header')) {
      assert.equal('agent' in record, false, `${record.type} record must be untouched`);
    }
  } finally {
    session.destroy();
    await fsp.rm(recorderBase, { recursive: true, force: true });
  }
});

test('a non-default agent stamps its decision records, so a recording says which vocabulary it holds', async () => {
  const recorderBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-cap-rec2-'));
  const { session } = makeSession({ id: 'rec2', name: 'rec2', adapter: agentWithout('statusLine') });
  const recorder = new SessionRecorder({ name: 'rec2', baseDir: recorderBase, recordData: false });
  session.setRecorder(recorder);
  try {
    await session.start();
    session.recordNotifyDecision({ kind: 'notify', ts: Date.now(), decision: 'suppressed' });
    await new Promise<void>((resolve) => { recorder._stream?.once('finish', () => resolve()); recorder.close(); });
    const file = fs.readdirSync(recorderBase).find((entry) => entry.endsWith('.jsonl'));
    const records = fs.readFileSync(path.join(recorderBase, String(file)), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.find((r) => r.type === 'header')?.agent, 'test-agent');
    const decision = records.find((r) => r.type === 'decision');
    assert.equal(decision?.agent, 'test-agent');
    assert.equal(decision?.decision, 'suppressed');
  } finally {
    session.destroy();
    await fsp.rm(recorderBase, { recursive: true, force: true });
  }
});

test('Sane YOLO capability filters both the Claude hook and its environment', async () => {
  const hookTools: NonNullable<SessionOptions['hookTools']> = [{ id: 'saneYolo', binPath: '/g/guard.js' }];
  await withHooks({ id: 'guard-on', name: 'guard-on', hookTools }, ({ session, settings, calls }) => {
    assert.equal(session.toSnapshot().saneYolo, true);
    assert.ok(settings.hooks.PreToolUse);
    assert.equal(calls[0].env.GLIMMERVOID_SANE_YOLO_PATH, '/g/guard.js');
    assert.equal(calls[0].env.CC_SAFETY_NET_PROJECT_TIGHTEN_ONLY, '1');
  });
  await withHooks({ id: 'guard-off', name: 'guard-off', hookTools, adapter: agentWithout('saneYolo') }, ({ session, settings, calls }) => {
    assert.equal(session.toSnapshot().saneYolo, false);
    assert.equal('PreToolUse' in settings.hooks, false);
    assert.equal(calls[0].env.GLIMMERVOID_SANE_YOLO_PATH, undefined);
    assert.equal(calls[0].env.CC_SAFETY_NET_HOME, process.env.CC_SAFETY_NET_HOME);
  });
});

test('a kimi initial prompt is typed only into a folder kimi already trusts, never into its trust dialog', async (t) => {
  const kimiHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-kimi-trust-'));
  t.after(() => fsp.rm(kimiHome, { recursive: true, force: true }));
  const prompt = 'First kimi task\x1b[201~\r/auto\r';
  async function typedIntoFreshSession(id: string, cwd: string = process.cwd()): Promise<string[]> {
    const writes: string[] = [];
    const session = new Session({
      id, name: id, path: cwd, agent: 'kimi', initialPrompt: prompt,
      spawnCommand: { path: process.execPath, kind: 'exe' },
      spawnEnv: { KIMI_CODE_HOME: kimiHome },
      ptySpawn: () => capturingPty(writes),
    });
    try {
      await session.start();
      session.transition('first_output');
      await new Promise((resolve) => setTimeout(resolve, 2200));
      return writes;
    } finally {
      session.destroy();
    }
  }

  assert.deepEqual(await typedIntoFreshSession('kimi-untrusted'), []);

  fs.mkdirSync(path.join(kimiHome, 'workspace-trust'));
  const symlinkedCwd = path.join(kimiHome, 'linked-project');
  fs.symlinkSync(process.cwd(), symlinkedCwd);
  fs.writeFileSync(path.join(kimiHome, 'workspace-trust', kimi.workspaceTrustKey(symlinkedCwd)), '{}');
  assert.deepEqual(await typedIntoFreshSession('kimi-symlink-trusted-only', symlinkedCwd), []);
  fs.writeFileSync(path.join(kimiHome, 'workspace-trust', kimi.workspaceTrustKey(fs.realpathSync(process.cwd()))), '{}');
  assert.deepEqual(await typedIntoFreshSession('kimi-trusted'), ['\x1b[200~First kimi task[201~/auto\x1b[201~', '\r']);
});

test('a claude prompt after a variadic flag such as --disallowedTools stays the prompt instead of becoming one more rule', () => {
  const prompt = 'Review this pull request';
  const args = claudeCode.buildArgs({ extraArgs: ['-p', '--disallowedTools', 'Edit', 'WebFetch'], initialPrompt: prompt });
  assert.deepEqual(args.slice(-4), ['Edit', 'WebFetch', '--', prompt]);
});
