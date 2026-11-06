import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { GlimmervoidConfig } from '../server/config-store.ts';
import type { ControlMessageRecord } from '../server/core/control-replay-core.ts';
import type { Session } from '../session/sessions.ts';
import { connectControl, controlDeps, createControlServer, testConfigStore } from './helpers/control-harness.ts';
import { STATES } from '../shared/states.ts';
import { plainSession } from './helpers/fake-session.ts';

interface ResumeFrame {
  type: string;
  id?: string;
  ok?: boolean;
  message?: string;
  resumeSessionId?: string | null;
}

function harness(sessions: Map<string, Session>, config: GlimmervoidConfig) {
  const broadcasts: ControlMessageRecord[] = [];
  const saveCalls: number[] = [];
  const server = createControlServer(controlDeps(config, {
    sessions,
    configStore: testConfigStore(config, { onSave: () => saveCalls.push(1) }),
    broadcastControl: (message) => { broadcasts.push(message); },
  }));
  const connection = connectControl<ResumeFrame>(server);
  connection.sent.length = 0;
  return { send: connection.send, sent: connection.sent, broadcasts, saveCalls };
}

test('resume-conversation persists the id, sets it on the session and acks without a session-resume broadcast', () => {
  const s = plainSession('p1');
  const cfg: GlimmervoidConfig = { projects: [{ id: 'p1', name: 'p1', path: 'C:/repo' }] };
  const h = harness(new Map([['p1', s]]), cfg);

  h.send({ type: 'resume-conversation', id: 'p1', conversationId: '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5' });

  assert.equal(cfg.projects[0].resumeSessionId, '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5', 'persisted on project record');
  assert.equal(s.resumeSessionId, '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5', 'set on live session');
  assert.equal(h.broadcasts.some((m) => m.type === 'session-resume'), false);
  const ack = h.sent.find((m) => m.type === 'resume-conversation-ack');
  assert.ok(ack && ack.ok === true, 'acked ok');
});

test('force-restart into an earlier conversation keeps the pick when the old agent reports its own conversation before exiting', () => {
  const runningConversation = '11111111-1111-4111-8111-111111111111';
  const earlierConversation = '22222222-2222-4222-8222-222222222222';
  const s = plainSession('p1');
  s.setResumeConversation(runningConversation);
  s.state = STATES.RUNNING;
  const cfg: GlimmervoidConfig = { projects: [{ id: 'p1', name: 'p1', path: 'C:/repo', resumeSessionId: runningConversation }] };
  const h = harness(new Map([['p1', s]]), cfg);

  h.send({ type: 'force-restart', id: 'p1', conversationId: earlierConversation });
  s.ingestHookSignal({ signal: 'ready', source: 'hook', ts: Date.now(), payload: { session_id: runningConversation } });

  assert.equal(s.resumeSessionId, earlierConversation);
  assert.equal(cfg.projects[0].resumeSessionId, earlierConversation);
});

const EARLIER_CONVERSATION = '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5';

interface AddSessionReply {
  type: string;
  requestId?: string;
  ok?: boolean;
  error?: string | null;
  sessionId?: string;
}

function withAddSessionFolders(run: (folders: { repo: string; claudeConfigDir: string }) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-control-add-resume-'));
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const repo = path.join(root, 'repo');
  const claudeConfigDir = path.join(root, 'claude');
  fs.mkdirSync(repo);
  fs.mkdirSync(path.join(claudeConfigDir, 'projects'), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  try {
    run({ repo, claudeConfigDir });
  } finally {
    if (previousClaudeConfigDir == null) delete process.env.CLAUDE_CONFIG_DIR;
    if (previousClaudeConfigDir != null) process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function addSession(config: GlimmervoidConfig, message: Record<string, unknown>): AddSessionReply | undefined {
  const server = createControlServer(controlDeps(config, { generateProjectId: () => 'dddddddd-resumed' }));
  const connection = connectControl<AddSessionReply>(server);
  connection.send({ type: 'add-session', requestId: 'a1', name: 'resumed', ...message });
  return connection.sent.find((frame) => frame.requestId === 'a1');
}

test('add-session with a conversation id found in another project folder persists it on the new project', () => {
  withAddSessionFolders(({ repo, claudeConfigDir }) => {
    const otherFolder = path.join(claudeConfigDir, 'projects', 'C--some-other-checkout');
    fs.mkdirSync(otherFolder);
    fs.writeFileSync(path.join(otherFolder, `${EARLIER_CONVERSATION}.jsonl`), '', 'utf8');
    const cfg: GlimmervoidConfig = { projects: [] };

    const reply = addSession(cfg, { path: repo, resumeSessionId: `  ${EARLIER_CONVERSATION}  ` });

    assert.deepEqual(reply, { type: 'add-session-result', requestId: 'a1', ok: true, error: null, sessionId: 'dddddddd-resumed' });
    assert.equal(cfg.projects[0]?.resumeSessionId, EARLIER_CONVERSATION);
  });
});

test('add-session without a conversation id leaves the new project without one, and saves no run settings the message carries', () => {
  withAddSessionFolders(({ repo }) => {
    const cfg: GlimmervoidConfig = { projects: [] };

    const reply = addSession(cfg, { path: repo, resumeSessionId: '   ', runSettings: { resumeSessionId: '--dangerously-skip-permissions', baseBranch: 'from-the-wire' } });

    assert.equal(reply?.ok, true);
    assert.equal('resumeSessionId' in (cfg.projects[0] ?? {}), false);
    assert.equal('baseBranch' in (cfg.projects[0] ?? {}), false);
  });
});

test('add-session refuses a malformed conversation id', () => {
  withAddSessionFolders(({ repo }) => {
    const cfg: GlimmervoidConfig = { projects: [] };

    const reply = addSession(cfg, { path: repo, resumeSessionId: '--dangerously-skip-permissions' });

    assert.equal(reply?.ok, false);
    assert.equal(reply?.error, 'Invalid conversation id');
    assert.equal(cfg.projects.length, 0);
  });
});

test('add-session refuses a conversation id for a shell session', () => {
  withAddSessionFolders(({ repo }) => {
    const cfg: GlimmervoidConfig = { projects: [] };

    const reply = addSession(cfg, { path: repo, agent: 'shell', resumeSessionId: EARLIER_CONVERSATION });

    assert.equal(reply?.ok, false);
    assert.match(String(reply?.error), /cannot resume a conversation/);
    assert.equal(cfg.projects.length, 0);
  });
});

test('add-session refuses a Claude conversation id that has no transcript under any project folder', () => {
  withAddSessionFolders(({ repo, claudeConfigDir }) => {
    fs.mkdirSync(path.join(claudeConfigDir, 'projects', 'C--unrelated'));
    const cfg: GlimmervoidConfig = { projects: [] };

    const reply = addSession(cfg, { path: repo, resumeSessionId: EARLIER_CONVERSATION });

    assert.equal(reply?.ok, false);
    assert.match(String(reply?.error), new RegExp(`No conversation ${EARLIER_CONVERSATION} was found under`));
    assert.equal(cfg.projects.length, 0);
  });
});
