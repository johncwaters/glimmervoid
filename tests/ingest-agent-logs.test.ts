import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAgentLogIngest } from '../server/ingest/ingest-agent-logs.ts';
import type { AgentLogIngestOptions } from '../server/ingest/ingest-agent-logs.ts';
import { createIngestLane } from '../server/ingest/ingest-wiring.ts';
import { resolveIngestConfig } from '../server/ingest/core/ingest-core.ts';
import type { AgentIngestEvent } from '../server/ingest/core/ingest-agent-core.ts';
import { encodeProjectDir } from '../session/core/conversation-history.ts';

type AgentLogIngest = ReturnType<typeof createAgentLogIngest>;

interface Homes {
  tmpDir: string;
  projects: string;
  codexSessions: string;
  grokSessions: string;
  kimiSessions: string;
  env: NodeJS.ProcessEnv;
}

interface HomesContext extends Homes {
  events: AgentIngestEvent[];
  warnings: string[];
  build: (overrides?: Partial<AgentLogIngestOptions>) => AgentLogIngest;
}

function makeHomes(): Homes {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-agentlogs-'));
  const claudeHome = path.join(tmpDir, 'claude');
  const codexHome = path.join(tmpDir, 'codex');
  const grokHome = path.join(tmpDir, 'grok');
  const kimiHome = path.join(tmpDir, 'kimi');
  const projects = path.join(claudeHome, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(grokHome, 'sessions'), { recursive: true });
  return {
    tmpDir,
    projects,
    codexSessions: path.join(codexHome, 'sessions'),
    grokSessions: path.join(grokHome, 'sessions'),
    kimiSessions: path.join(kimiHome, 'sessions'),
    env: {
      CLAUDE_CONFIG_DIR: claudeHome,
      CODEX_HOME: codexHome,
      GROK_HOME: grokHome,
      KIMI_CODE_HOME: kimiHome,
      HOME: tmpDir,
      USERPROFILE: tmpDir,
    },
  };
}

function parkedTimer(): NodeJS.Timeout {
  const handle = setTimeout(() => {}, 2 ** 30);
  handle.unref();
  return handle;
}

function inertTimers(): Partial<AgentLogIngestOptions> {
  return {
    setIntervalFn: () => parkedTimer(),
    clearIntervalFn: (handle) => { clearTimeout(handle); },
    setTimeoutFn: () => parkedTimer(),
    clearTimeoutFn: (handle) => { clearTimeout(handle); },
  };
}

function withHomes(fn: (context: HomesContext) => Promise<void>): () => Promise<void> {
  return async () => {
    const homes = makeHomes();
    const events: AgentIngestEvent[] = [];
    const warnings: string[] = [];
    const adapters: AgentLogIngest[] = [];
    const build = (overrides: Partial<AgentLogIngestOptions> = {}): AgentLogIngest => {
      const adapter = createAgentLogIngest({
        publish: (event) => events.push(event),
        env: homes.env,
        logger: { warn: (message: string) => { warnings.push(message); } },
        ...inertTimers(),
        ...overrides,
      });
      adapters.push(adapter);
      return adapter;
    };
    try {
      await fn({ ...homes, events, warnings, build });
    } finally {
      for (const adapter of adapters) adapter.stop();
      fs.rmSync(homes.tmpDir, { recursive: true, force: true });
    }
  };
}

function agentLogsOf(lane: ReturnType<typeof createIngestLane>) {
  if (!lane.agentLogs) throw new Error('the agentLogs source is off on this lane');
  return lane.agentLogs;
}

function claudeAssistant({ text = null, tools = [], sessionId, cwd = 'C:\\repo', ts = null }: {
  text?: string | null;
  tools?: { name: string; input: Record<string, unknown> }[];
  sessionId: string;
  cwd?: string;
  ts?: string | null;
}): string {
  const content: Record<string, unknown>[] = [];
  if (text) content.push({ type: 'text', text });
  for (const tool of tools) content.push({ type: 'tool_use', id: 'tu-1', name: tool.name, input: tool.input });
  return `${JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content },
    cwd,
    sessionId,
    timestamp: ts || new Date().toISOString(),
  })}\n`;
}

function seedClaudeTranscript(projects: string, { dirName = 'C--repo', sessionId = 'sess-live', lines = [] }: {
  dirName?: string;
  sessionId?: string;
  lines?: string[];
} = {}): string {
  const dir = path.join(projects, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.join(''), 'utf8');
  return filePath;
}

function append(filePath: string, text: string): void {
  fs.appendFileSync(filePath, text, 'utf8');
}

test('layer 2, the workdir shape: a dispatch transcript is excluded with NO ledger at all', withHomes(async ({ projects, events, build }) => {
  const workDir = path.join(os.tmpdir(), 'glimmervoid-visions-abc123');
  const filePath = seedClaudeTranscript(projects, {
    dirName: encodeProjectDir(workDir),
    sessionId: 'unrecorded-visions',
  });

  const adapter = build();
  await adapter.start();
  assert.equal(adapter.trackedCount, 0, 'a dispatch workdir is not even listed');
  assert.equal(adapter.watchCount, 3, 'and it earns no watcher either, only the three vendor roots');

  append(filePath, claudeAssistant({ text: 'unrecorded dispatch output', sessionId: 'unrecorded-visions', cwd: workDir }));
  await adapter.poll();
  await adapter.discover();
  await adapter.poll();
  assert.equal(events.length, 0);
}));

function setMtime(target: string, whenMs: number): void {
  const when = new Date(whenMs);
  fs.utimesSync(target, when, when);
}

test('a new transcript among finished ones is still found, whether or not creating it moved the dir mtime', withHomes(async ({ projects, events, build }) => {
  const longAgo = Date.now() - (60 * 60 * 1000);
  const dir = path.join(projects, 'C--settled');
  fs.mkdirSync(dir, { recursive: true });
  for (let index = 0; index < 20; index += 1) {
    const filePath = path.join(dir, `old-${index}.jsonl`);
    fs.writeFileSync(filePath, '', 'utf8');
    setMtime(filePath, longAgo);
  }
  const adapter = build();
  await adapter.start();
  assert.equal(adapter.trackedCount, 0);

  const fresh = path.join(dir, 'brand-new.jsonl');
  fs.writeFileSync(fresh, '', 'utf8');
  await adapter.discover();
  assert.equal(adapter.trackedCount, 1);

  append(fresh, claudeAssistant({ text: 'a new session in an old project', sessionId: 'brand-new' }));
  await adapter.poll();
  assert.deepEqual(events.map((event) => event.summary), ['claude: a new session in an old project']);
}));

test('a transcript born in the tick the last listing read is still found, not lost for the life of the daemon', withHomes(async ({ projects, build }) => {
  const tick = Math.floor(Date.now() / 1000) * 1000;
  const dir = path.join(projects, 'C--same-tick');
  fs.mkdirSync(dir, { recursive: true });
  setMtime(dir, tick);
  const adapter = build({ nowFn: () => tick });
  await adapter.start();
  assert.equal(adapter.trackedCount, 0);

  fs.writeFileSync(path.join(dir, 'sess-same-tick.jsonl'), '', 'utf8');
  setMtime(dir, tick);
  await adapter.discover();
  assert.equal(adapter.trackedCount, 1, 'an unsettled listing must be re-read rather than trusted');
}));

test('a kimi transcript publishes its assistant turns and tool calls under the cwd its profile record names', withHomes(async ({ kimiSessions, events, build }) => {
  const agentDir = path.join(kimiSessions, 'wd_repo_1bd23b510277', 'session_766a47d0-9cb9-4af9-8f5e-1eaf9374b85e', 'agents', 'main');
  fs.mkdirSync(agentDir, { recursive: true });
  const filePath = path.join(agentDir, 'wire.jsonl');
  const record = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;
  fs.writeFileSync(filePath, [
    record({ type: 'metadata', protocol_version: '1.5', created_at: 1793212054305 }),
    record({ type: 'profile.bind', agentId: 'main', environmentDisclosure: { cwd: '/work/repo' }, time: 1793212054320 }),
  ].join(''), 'utf8');
  const adapter = build();
  await adapter.start();

  append(filePath, record({
    type: 'agent.message.appended',
    time: 1793212068608,
    message: { message: { role: 'assistant', content: [{ type: 'think', think: 'reading it' }], toolCalls: [{ type: 'function', id: 'tool_1', name: 'Read', arguments: '{"path":"a.txt"}' }] } },
  }));
  append(filePath, record({ type: 'agent.message.appended', time: 1793212068609, message: { message: { role: 'tool', content: [{ type: 'text', text: '1\thi' }] } } }));
  append(filePath, record({
    type: 'agent.message.appended',
    time: 1793212068610,
    message: { message: { role: 'assistant', content: [{ type: 'text', text: 'The file says hi.' }], toolCalls: [] } },
  }));
  await adapter.poll();

  assert.deepEqual(events.map((event) => event.summary), ['kimi: Read a.txt', 'kimi: The file says hi.']);
  for (const event of events) {
    assert.deepEqual(event.scope, { root: '/work/repo', sessionId: 'session_766a47d0-9cb9-4af9-8f5e-1eaf9374b85e' });
  }
}));

function laneWith(
  homes: Homes,
  rawConfig: unknown,
  overrides: Partial<AgentLogIngestOptions> = {},
) {
  const broadcasts: Record<string, unknown>[] = [];
  const lane = createIngestLane({
    config: resolveIngestConfig(rawConfig),
    broadcast: (message) => broadcasts.push(message),
    logger: { warn: () => {} },
    ...inertTimers(),
    agentLogOptions: { env: homes.env, ...overrides },
  });
  return { lane, broadcasts };
}

test('a secret past a long prefix in a tool command is scrubbed whole, never down to its first word', withHomes(async (homes) => {
  const filePath = seedClaudeTranscript(homes.projects, { sessionId: 'sess-target' });
  const { lane } = laneWith(homes, { enabled: true, sources: { agentLogs: { enabled: true } } });
  try {
    await agentLogsOf(lane).start();
    append(filePath, claudeAssistant({
      text: 'Exporting it now.',
      sessionId: 'sess-target',
      tools: [{
        name: 'Bash',
        input: { command: `echo ${'a'.repeat(90)} --password "hunter two three four five six"` },
      }],
    }));
    await agentLogsOf(lane).poll();

    const tool = lane.recentEvents().find((event) => event.kind === 'agent-tool');
    if (!tool) throw new Error('no tool event reached the ring');
    assert.ok(tool.summary.startsWith('claude: Bash '), `the M7 vendor prefix is gone: ${tool.summary}`);
    assert.ok(tool.summary.includes('--password [scrubbed]'), tool.summary);
    for (const word of ['hunter', 'two three four five', 'six']) {
      assert.ok(!tool.summary.includes(word), `leaked ${word}: ${tool.summary}`);
    }
  } finally {
    lane.stop();
  }
}));

test('a secret past a long prefix in a turn summary is scrubbed whole, and the ring is the only slice', withHomes(async (homes) => {
  const filePath = seedClaudeTranscript(homes.projects, { sessionId: 'sess-turn-secret' });
  const { lane } = laneWith(homes, { enabled: true, sources: { agentLogs: { enabled: true } } });
  try {
    await agentLogsOf(lane).start();
    append(filePath, claudeAssistant({
      text: `I ran ${'w'.repeat(200)} with --password "hunter two three four five six"`,
      sessionId: 'sess-turn-secret',
    }));
    append(filePath, claudeAssistant({ text: `a very long turn ${'z'.repeat(900)}`, sessionId: 'sess-turn-secret' }));
    await agentLogsOf(lane).poll();

    const events = lane.recentEvents();
    const secret = events.find((event) => event.summary.includes('--password'));
    if (!secret) throw new Error('the command event never reached the ring');
    assert.ok(secret.summary.startsWith('claude: I ran '), secret.summary);
    assert.ok(secret.summary.endsWith('--password [scrubbed]'), secret.summary);
    for (const word of ['hunter', 'two three four five', 'six']) {
      assert.ok(!secret.summary.includes(word), `leaked ${word}: ${secret.summary}`);
    }

    const long = events.find((event) => event.summary.includes('a very long turn'));
    if (!long) throw new Error('the long turn never reached the ring');
    assert.equal(long.summary.length, 400, 'the ring bound is the one slice in the pipeline');
    assert.ok(long.summary.startsWith('claude: '), long.summary);
  } finally {
    lane.stop();
  }
}));
