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
import { createPackSessionFiles } from '../server/packs/pack-session-files.ts';
import { PackHook } from '../shared/contracts/pack.ts';
import { packHookFilesEnv } from '../session/core/pack-hook-core.ts';
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

const PACK_GATE_SOURCE = `let text = '';
process.stdin.on('data', (chunk) => { text += chunk; });
process.stdin.on('end', () => {
  const input = JSON.parse(text);
  if (input.tool.command === 'crash') throw new Error('boom');
  if (input.tool.command === 'hang') setInterval(() => {}, 1000);
  if (input.tool.command === 'hang') return;
  if (input.tool.filePaths.includes('blocked.txt') || input.tool.command === 'git push') {
    process.stderr.write('no spec for ' + input.sessionId);
    process.exit(2);
  }
});
`;

test('an approved pack hook that exits 2 denies the matching tool call in each agent dialect, and a crash, a timeout or an unwatched tool lets the call run', async () => {
  const packRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-pack-hooks-'));
  try {
    const packSessionFiles = createPackSessionFiles({ root: packRoot });
    const hook = PackHook.parse({ id: 'spec-gate', description: 'Needs a spec', event: 'beforeTool', command: ['node', '{packDir}/hooks/gate.mjs'], timeoutSeconds: 1 });
    await packSessionFiles.sync([{ packName: 'gates', fingerprint: 'a'.repeat(64), context: null, skills: [], hooks: [hook], packFiles: new Map([['hooks/gate.mjs', Buffer.from(PACK_GATE_SOURCE)]]) }]);
    const env = packHookFilesEnv(packSessionFiles.launch()?.hookFiles ?? []);
    const relay = async (flavor: string, payload: unknown, relayEnv: Record<string, string> = env) => {
      const stdout = fakeStdout();
      const outcome = await main('packHooks', relayEnv, fakeStdin(JSON.stringify(payload)), stdout, fakeHookTool(''), flavor);
      return { reason: outcome.reason, written: stdout.written.join('') };
    };
    const claudeDenial = await relay('claude', { session_id: 's-1', cwd: packRoot, tool_name: 'Write', tool_input: { file_path: 'blocked.txt' } });
    assert.deepEqual(JSON.parse(claudeDenial.written), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[gates/spec-gate] no spec for s-1' } });
    const antigravityDenial = await relay('antigravity', { conversationId: 'c-1', toolCall: { name: 'write_file', args: { TargetFile: 'blocked.txt' } } });
    assert.deepEqual(JSON.parse(antigravityDenial.written), { decision: 'deny', reason: '[gates/spec-gate] no spec for c-1' });
    const codexPatchDenial = await relay('codex', { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: blocked.txt\n+x\n*** End Patch' } });
    assert.equal(codexPatchDenial.reason, 'denied');
    assert.equal((await relay('claude', { session_id: 's-2', tool_name: 'Monitor', tool_input: { command: 'git push' } })).reason, 'denied');
    assert.equal((await relay('antigravity', { toolCall: { name: 'write_to_file', args: { TargetFile: 'blocked.txt' } } })).reason, 'denied');
    for (const command of ['crash', 'hang', 'ls']) assert.deepEqual(await relay('pi', { tool_name: 'bash', tool_input: { command } }), { reason: 'allowed', written: '' });
    assert.deepEqual(await relay('kimi', { tool_name: 'Read', tool_input: { file_path: 'blocked.txt' } }), { reason: 'allowed', written: '' });
    assert.deepEqual(await relay('claude', { tool_name: 'Write', tool_input: { file_path: 'blocked.txt' } }, {}), { reason: 'no-pack-hooks', written: '' });
  } finally {
    fs.rmSync(packRoot, { recursive: true, force: true });
  }
});
