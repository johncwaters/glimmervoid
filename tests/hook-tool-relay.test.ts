import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { main, runHookTool } from '../session/hook-tool-relay.ts';
import { RTK_PATH_ENV } from '../session/core/rtk-hook-core.ts';
const ENVELOPE = '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git log"}}';
const REWRITE = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecisionReason: 'RTK auto-rewrite',
    updatedInput: { command: 'rtk git log' },
  },
});

interface RtkInvocation {
  rtkPath: string;
  body: string;
}

function fakeStdin(text: string) {
  return Readable.from([Buffer.from(text, 'utf8')]);
}

function fakeStdout() {
  const written: string[] = [];
  return { written, write: (chunk: string) => { written.push(String(chunk)); return true; } };
}

function fakeRtk(stdoutText: string, seen: RtkInvocation[] = []) {
  return (rtkPath: string, body: Buffer) => {
    seen.push({ rtkPath, body: body.toString('utf8') });
    return Promise.resolve(stdoutText);
  };
}

test('a rewrite is completed with permissionDecision and written as one line', async () => {
  const stdout = fakeStdout();
  const seen: RtkInvocation[] = [];
  const result = await main(
    'rtk',
    { [RTK_PATH_ENV]: '/home/carbon/.local/bin/rtk' },
    fakeStdin(ENVELOPE),
    stdout,
    fakeRtk(REWRITE, seen),
  );
  assert.equal(result.code, 0);
  assert.deepEqual(seen, [{ rtkPath: '/home/carbon/.local/bin/rtk', body: ENVELOPE }]);
  assert.equal(stdout.written.length, 1);
  assert.equal(stdout.written[0].endsWith('\n'), true);
  const rewritten = JSON.parse(stdout.written[0]) as { hookSpecificOutput: Record<string, unknown> };
  assert.equal(rewritten.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal('additionalContext' in rewritten.hookSpecificOutput, false);
});

test('a rewrite relayed for Claude discloses the rtk condensing and leaves the permission decision to Claude', async () => {
  const stdout = fakeStdout();
  await main('rtk', { [RTK_PATH_ENV]: '/bin/rtk' }, fakeStdin(ENVELOPE), stdout, fakeRtk(REWRITE), 'claude');
  const rewritten = JSON.parse(stdout.written[0]) as { hookSpecificOutput: Record<string, unknown> };
  assert.match(String(rewritten.hookSpecificOutput.additionalContext), /`rtk git log`.*condensed.*`rtk proxy <command>`/);
  assert.equal('permissionDecision' in rewritten.hookSpecificOutput, false);
});

test('Sane YOLO forwards Grok verdicts byte for byte and passes the envelope untouched', async () => {
  for (const verdict of ['{"decision":"deny","reason":"blocked"}\n', '{"decision":"allow"}\n']) {
    const stdout = fakeStdout();
    const seen: RtkInvocation[] = [];
    const outcome = await main('saneYolo', { GLIMMERVOID_SANE_YOLO_PATH: '/g/guard.js' }, fakeStdin(ENVELOPE), stdout, fakeRtk(verdict, seen));
    assert.equal(outcome.code, 0);
    assert.deepEqual(stdout.written, [verdict]);
    assert.deepEqual(seen, [{ rtkPath: '/g/guard.js', body: ENVELOPE }]);
  }
});

test('Sane YOLO runner uses Node and the Grok host flag', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-guard-relay-'));
  try {
    const scriptPath = path.join(directory, 'guard.cjs');
    fs.writeFileSync(scriptPath, 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify(process.argv.slice(2))));');
    assert.equal(await runHookTool('saneYolo', scriptPath, Buffer.from(ENVELOPE)), '["hook","--grok-build"]');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
