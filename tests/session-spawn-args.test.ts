import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session } from '../session/sessions.ts';
import { encodeProjectDir } from '../session/core/conversation-history.ts';
import { STATES } from '../shared/states.ts';
import { waitFor } from './helpers/wait-for.ts';
import { fakePty } from './helpers/fake-pty.ts';

interface ArgvCall {
  file: string;
  args: string[];
}

const claudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-spawn-args-'));
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

test('start() appends extraClaudeArgs then the initialPrompt as the final positional arg', async () => {
  const calls: ArgvCall[] = [];
  const s = new Session({
    id: 'team:run1:writer',
    name: 'writer',
    path: process.cwd(),
    dangerouslySkipPermissions: true,
    extraClaudeArgs: ['-p', '--model', 'sonnet'],
    initialPrompt: 'STAGE PROMPT TEXT\nwith a newline',
    ephemeral: true,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args) => { calls.push({ file, args }); return fakePty(); },
  });
  try {
    await s.start();
    assert.equal(calls.length, 1, 'spawned once');

    assert.deepEqual(calls[0].args, [
      '--dangerously-skip-permissions',
      '-p',
      '--model',
      'sonnet',
      'STAGE PROMPT TEXT\nwith a newline',
    ]);

    assert.equal(calls[0].args[calls[0].args.length - 1], 'STAGE PROMPT TEXT\nwith a newline');
    assert.equal(s.toSnapshot().ephemeral, true);
  } finally {
    s.destroy();
  }
});

test('a session with no team options spawns exactly as before (no extra args)', async () => {
  const calls: ArgvCall[] = [];
  const s = new Session({
    id: 'plain',
    name: 'plain',
    path: process.cwd(),
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args) => { calls.push({ file, args }); return fakePty(); },
  });
  try {
    await s.start();
    assert.deepEqual(calls[0].args, [], 'no settings, no perms, no team args');
    assert.equal(s.toSnapshot().ephemeral, false);
  } finally {
    s.destroy();
  }
});

test('normal restart keeps the captured resume id in spawn args', async () => {
  const calls: ArgvCall[] = [];
  const resumeSessionId = '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5';
  writeClaudeTranscript(process.cwd(), resumeSessionId);
  const s = new Session({
    id: 'resume-restart',
    name: 'resume-restart',
    path: process.cwd(),
    resumeSessionId,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args) => { calls.push({ file, args }); return fakePty(); },
    killProc: (_args, _opts, cb) => cb(null, '', ''),
  });
  try {
    await s.start();
    s.state = STATES.DONE;

    assert.equal(s.restart(), true, 'restart accepted');
    await waitFor(() => calls.length === 2);

    const args = calls.at(-1)?.args ?? [];
    const resumeIndex = args.indexOf('--resume');
    assert.notEqual(resumeIndex, -1, 'restart spawned with --resume');
    assert.equal(args[resumeIndex + 1], resumeSessionId);
  } finally {
    s.destroy();
  }
});

test('a missing Claude transcript spawns without --resume and keeps the bound resume id', async () => {
  const calls: ArgvCall[] = [];
  const cleared: unknown[] = [];
  const warnings: string[] = [];
  const resumeSessionId = '22222222-2222-4222-8222-222222222222';
  const expectedTranscriptPath = path.join(
    claudeConfigDir,
    'projects',
    encodeProjectDir(process.cwd()),
    `${resumeSessionId}.jsonl`,
  );
  const originalWarn = console.warn;
  console.warn = (message: unknown) => { warnings.push(String(message)); };
  const s = new Session({
    id: 'missing-resume-transcript',
    name: 'missing-resume-transcript',
    path: process.cwd(),
    resumeSessionId,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args) => { calls.push({ file, args }); return fakePty(); },
  });
  s.on('resume-cleared', (payload) => cleared.push(payload));
  try {
    await s.start();
    assert.equal(calls.length, 1, 'spawned once');
    assert.equal(calls[0].args.includes('--resume'), false, 'spawned without the stale resume id');
    assert.equal(s.resumeSessionId, resumeSessionId, 'bound resume id survives the probe miss');
    assert.deepEqual(cleared, []);
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0] ?? '',
      new RegExp(`^\\[session:missing-resume-transcript\\] spawning without the stale resume id ${resumeSessionId} `
        + 'because no transcript exists at any of: '));
    assert.ok(
      warnings[0]?.includes(expectedTranscriptPath),
      'the warn names every path probed, not just the first');
    const blankSpawnSessionId = '33333333-3333-4333-8333-333333333333';
    s.ingestHookSignal({
      signal: 'session-start',
      source: 'hook',
      ts: Date.now(),
      payload: { session_id: blankSpawnSessionId, source: 'startup' },
    });
    assert.equal(s.resumeSessionId, resumeSessionId, 'a blank child never overwrites the saved conversation');
  } finally {
    console.warn = originalWarn;
    s.destroy();
  }
});

test('fresh restart clears the resume id and spawns without --resume', async () => {
  const calls: ArgvCall[] = [];
  const cleared: unknown[] = [];
  const resumeSessionId = '4a3d4462-4cf7-4a23-8f00-ccec89a48ba5';
  writeClaudeTranscript(process.cwd(), resumeSessionId);
  const s = new Session({
    id: 'fresh-restart',
    name: 'fresh-restart',
    path: process.cwd(),
    resumeSessionId,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args) => { calls.push({ file, args }); return fakePty(); },
    killProc: (_args, _opts, cb) => cb(null, '', ''),
  });
  s.on('resume-cleared', (payload) => cleared.push(payload));
  try {
    await s.start();
    s.state = STATES.DONE;

    assert.equal(s.restart({ fresh: true }), true, 'fresh restart accepted');
    await waitFor(() => calls.length === 2);

    assert.equal(s.resumeSessionId, null, 'live resume id cleared');
    assert.deepEqual(cleared, [{ id: 'fresh-restart' }]);
    assert.equal(calls.at(-1)?.args.includes('--resume'), false, 'fresh restart spawned without --resume');
  } finally {
    s.destroy();
  }
});

test('a hook transcript path the derived candidates cannot reproduce still resumes the next spawn', async () => {
  const calls: ArgvCall[] = [];
  const warnings: string[] = [];
  const resumeSessionId = '44444444-4444-4444-8444-444444444444';
  const relocatedTranscriptPath = path.join(claudeConfigDir, 'relocated', `${resumeSessionId}.jsonl`);
  fs.mkdirSync(path.dirname(relocatedTranscriptPath), { recursive: true });
  fs.writeFileSync(relocatedTranscriptPath, '', 'utf8');
  const originalWarn = console.warn;
  console.warn = (message: unknown) => { warnings.push(String(message)); };
  const s = new Session({
    id: 'relocated-transcript',
    name: 'relocated-transcript',
    path: process.cwd(),
    resumeSessionId,
    spawnCommand: { path: process.execPath, kind: 'exe' },
    ptySpawn: (file, args) => { calls.push({ file, args }); return fakePty(); },
    killProc: (_args, _opts, cb) => cb(null, '', ''),
  });
  try {
    await s.start();
    assert.equal(calls[0].args.includes('--resume'), false, 'no derived candidate reproduces the relocated transcript');
    assert.equal(warnings.length, 1);

    s.ingestHookSignal({
      signal: 'ready',
      source: 'hook',
      ts: Date.now(),
      payload: { session_id: resumeSessionId, transcript_path: relocatedTranscriptPath },
    });
    s.state = STATES.DONE;
    assert.equal(s.restart(), true, 'restart accepted');
    await waitFor(() => calls.length === 2);

    const args = calls.at(-1)?.args ?? [];
    const resumeIndex = args.indexOf('--resume');
    assert.notEqual(resumeIndex, -1, 'the reported transcript path survived into the restart');
    assert.equal(args[resumeIndex + 1], resumeSessionId);
  } finally {
    console.warn = originalWarn;
    s.destroy();
  }
});
