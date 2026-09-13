import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../session/sessions.ts';
import { encodeProjectDir } from '../session/core/conversation-history.ts';
import { fakePty } from './helpers/fake-pty.ts';
import type { SessionOptions } from '../session/sessions.ts';

interface ArgvCall {
  file: string;
  args: string[];
}

const claudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-sessions-resume-'));
const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

function writeClaudeTranscript(cwd: string, resumeSessionId: string): void {
  const transcriptPath = path.join(
    claudeConfigDir,
    'projects',
    encodeProjectDir(cwd),
    `${resumeSessionId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, '', 'utf8');
}

after(() => {
  if (previousClaudeConfigDir == null) delete process.env.CLAUDE_CONFIG_DIR;
  if (previousClaudeConfigDir != null) process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
  fs.rmSync(claudeConfigDir, { recursive: true, force: true });
});

function spawnArgsFor(extra: Partial<SessionOptions>) {
  const calls: ArgvCall[] = [];
  const s = new Session({
    id: 'resume-int',
    name: 'resume-int',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args) => { calls.push({ file, args }); return fakePty(); },
    ...extra,
  });
  return { s, calls };
}

test('start() injects --resume <id> when resumeSessionId is set', async () => {
  const resumeSessionId = '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5';
  writeClaudeTranscript(process.cwd(), resumeSessionId);
  const { s, calls } = spawnArgsFor({ resumeSessionId });
  try {
    await s.start();
    assert.equal(calls.length, 1, 'spawned once');
    const args = calls[0].args;
    const i = args.indexOf('--resume');
    assert.ok(i !== -1, `expected --resume in args, got ${JSON.stringify(args)}`);
    assert.equal(args[i + 1], '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5', '--resume followed by the id');
  } finally {
    s.destroy();
  }
});

test('start() omits --resume when no resumeSessionId is set', async () => {
  const { s, calls } = spawnArgsFor({});
  try {
    await s.start();
    assert.ok(!calls[0].args.includes('--resume'), 'no --resume token when unbound');
  } finally {
    s.destroy();
  }
});

test('setResumeConversation binds and clears the resume id, reflected in toSnapshot', () => {
  const s = new Session({ id: 's', name: 's', path: process.cwd() });
  try {
    assert.equal(s.resumeSessionId, null);
    assert.equal(s.toSnapshot().resumeSessionId, null);
    s.setResumeConversation('abcd1234-0000-0000-0000-abcdabcdabcd');
    assert.equal(s.resumeSessionId, 'abcd1234-0000-0000-0000-abcdabcdabcd');
    assert.equal(s.toSnapshot().resumeSessionId, 'abcd1234-0000-0000-0000-abcdabcdabcd');
    s.setResumeConversation(null);
    assert.equal(s.resumeSessionId, null);
  } finally {
    s.destroy();
  }
});
