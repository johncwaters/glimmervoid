import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { main, runHookTool } from '../session/hook-tool-relay.ts';
import { COPILOT_SANE_YOLO_FLAVOR, QWEN_SANE_YOLO_FLAVOR } from '../session/core/sane-yolo.ts';
import { resolvePackageBin } from '../server/runtime-paths.ts';
const ENVELOPE = '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git log"}}';

interface HookToolInvocation {
  binPath: string;
  body: string;
}

function fakeStdin(text: string) {
  return Readable.from([Buffer.from(text, 'utf8')]);
}

function fakeStdout() {
  const written: string[] = [];
  return { written, write: (chunk: string) => { written.push(String(chunk)); return true; } };
}

function fakeHookTool(stdoutText: string, seen: HookToolInvocation[] = []) {
  return (binPath: string, body: Buffer) => {
    seen.push({ binPath, body: body.toString('utf8') });
    return Promise.resolve(stdoutText);
  };
}

test('Sane YOLO forwards Grok verdicts byte for byte and passes the envelope untouched', async () => {
  for (const verdict of ['{"decision":"deny","reason":"blocked"}\n', '{"decision":"allow"}\n']) {
    const stdout = fakeStdout();
    const seen: HookToolInvocation[] = [];
    const outcome = await main('saneYolo', { GLIMMERVOID_SANE_YOLO_PATH: '/g/guard.js' }, fakeStdin(ENVELOPE), stdout, fakeHookTool(verdict, seen));
    assert.equal(outcome.code, 0);
    assert.deepEqual(stdout.written, [verdict]);
    assert.deepEqual(seen, [{ binPath: '/g/guard.js', body: ENVELOPE }]);
  }
});

test('Sane YOLO runner uses Node and the Grok host flag', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-guard-relay-'));
  try {
    const scriptPath = path.join(directory, 'guard.cjs');
    fs.writeFileSync(scriptPath, 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify(process.argv.slice(2))));');
    assert.equal(await runHookTool(scriptPath, Buffer.from(ENVELOPE)), '["hook","--grok-build"]');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const SHELL_TOOL_CALLS = [
  { agentFlavor: QWEN_SANE_YOLO_FLAVOR, payload: { hook_event_name: 'PreToolUse', session_id: 'qwen-session', cwd: os.tmpdir(), tool_name: 'run_shell_command', tool_input: { command: 'git reset --hard', directory: os.tmpdir(), description: 'reset' } } },
  { agentFlavor: QWEN_SANE_YOLO_FLAVOR, payload: { hook_event_name: 'PreToolUse', session_id: 'qwen-session', cwd: os.tmpdir(), tool_name: 'monitor', tool_input: { command: 'git reset --hard', directory: os.tmpdir(), description: 'reset' } } },
  { agentFlavor: COPILOT_SANE_YOLO_FLAVOR, payload: { sessionId: 'copilot-session', cwd: os.tmpdir(), toolName: 'write_bash', toolArgs: JSON.stringify({ shellId: '1', input: 'git reset --hard\n' }) } },
];

for (const { agentFlavor, payload } of SHELL_TOOL_CALLS) {
  const toolName = 'tool_name' in payload ? payload.tool_name : payload.toolName;
  test(`Sane YOLO refuses a ${agentFlavor} ${toolName} shell command through the real Safety Net`, async () => {
    const binPath = resolvePackageBin('cc-safety-net', 'cc-safety-net');
    assert.ok(binPath, 'cc-safety-net is a dependency');
    const verdict = await runHookTool(binPath, Buffer.from(JSON.stringify(payload)), agentFlavor);
    assert.match(verdict, /"(decision|permissionDecision)":"deny"/);
  });
}
