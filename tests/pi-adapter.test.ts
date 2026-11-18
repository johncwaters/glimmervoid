import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import pi from '../session/adapters/pi.ts';
import { renderPiExtension } from '../session/core/pi-extension-core.ts';
import { permissionReplyFor } from '../session/core/claude-approval-core.ts';
import { CONVERSATION_PERMISSION_HOOK_EVENT } from '../shared/contracts/session.ts';
import { parsePiModels } from '../shared/agent-models-core.ts';
import type { GeneratedHomeInjection } from '../session/adapters/index.ts';

type PiHandler = (event: Record<string, unknown>, context: FakePiContext) => Promise<unknown>;

interface FakePiContext {
  hasUI: boolean;
  sessionManager: { getSessionId(): string };
  ui: { confirm(title: string, body: string, options: { signal: AbortSignal }): Promise<boolean> };
}

const RELAY_STUB_SOURCE = `import fs from "node:fs";
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (body += chunk));
process.stdin.on("end", () => {
  fs.appendFileSync(process.env.RELAY_LOG, process.argv[2] + "\\n");
  if (process.env.RELAY_HELD_REPLY && process.argv[2] === process.env.RELAY_HELD_EVENT) process.stdout.write(process.env.RELAY_HELD_REPLY);
});
`;

async function loadExtensionWithRelayLog(folder: string): Promise<{ handlers: Map<string, PiHandler>; relayedEvents(): string[] }> {
  const relayStubPath = path.join(folder, 'relay-stub.mjs');
  const relayLogPath = path.join(folder, 'relay.log');
  fs.writeFileSync(relayStubPath, RELAY_STUB_SOURCE);
  const extensionSource = renderPiExtension([process.execPath, relayStubPath]);
  assert.ok(extensionSource);
  const extensionPath = path.join(folder, 'glimmervoid.mjs');
  fs.writeFileSync(extensionPath, extensionSource);
  process.env.GLIMMERVOID_HOOK_URL = 'http://127.0.0.1:1/hook/test';
  process.env.RELAY_LOG = relayLogPath;
  const { default: registerExtension } = await import(pathToFileURL(extensionPath).href);
  const handlers = new Map<string, PiHandler>();
  registerExtension({
    on: (eventName: string, handler: PiHandler) => handlers.set(eventName, handler),
    registerFlag: () => {},
    getFlag: () => false,
    registerMcpServer: () => {},
    registerTool: () => {},
    getSessionName: () => null,
  });
  const relayedEvents = () => (fs.existsSync(relayLogPath) ? fs.readFileSync(relayLogPath, 'utf8').trim().split('\n') : []);
  return { handlers, relayedEvents };
}

async function waitForRelayedCount(relayedEvents: () => string[], count: number): Promise<string[]> {
  for (let attempt = 0; attempt < 100 && relayedEvents().length < count; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  return relayedEvents();
}

test('a pi turn with a denied bash call relays events the pi adapter reads as Claude-like status, blocks the denied call, and runs a read-only command without asking', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-extension-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const { handlers, relayedEvents } = await loadExtensionWithRelayLog(folder);
  const context: FakePiContext = { hasUI: true, sessionManager: { getSessionId: () => 'pi-session' }, ui: { confirm: async () => false } };
  const emit = (eventName: string, event: Record<string, unknown> = {}) => handlers.get(eventName)?.(event, context);

  await emit('session_start', { reason: 'startup' });
  await emit('input', { text: 'run ls', source: 'interactive' });
  await emit('agent_start');
  const readOnlyDecision = await emit('tool_call', { toolName: 'bash', input: { command: 'git status' } });
  const toolDecision = await emit('tool_call', { toolName: 'bash', input: { command: 'ls; rm -rf build' } });
  const powershellDecision = await emit('tool_call', { toolName: 'powershell', input: { command: 'Remove-Item -Recurse build' } });
  await emit('agent_settled', { aborted: false });

  assert.equal(readOnlyDecision, undefined);
  assert.deepEqual(toolDecision, { block: true, reason: 'The operator denied this bash call.' });
  assert.deepEqual(powershellDecision, { block: true, reason: 'The operator denied this powershell call.' });
  const statuses = (await waitForRelayedCount(relayedEvents, 8)).map((event) => pi.mapHookToSignal(event));
  assert.deepEqual(statuses, ['session-start', 'resume', 'working', 'awaiting-input', 'working', 'awaiting-input', 'working', 'ready']);
});

test('a pi bash call denied from Chat with a message is blocked with the operator words as its reason', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-extension-'));
  t.after(() => {
    delete process.env.RELAY_HELD_EVENT;
    delete process.env.RELAY_HELD_REPLY;
    fs.rmSync(folder, { recursive: true, force: true });
  });
  process.env.RELAY_HELD_EVENT = CONVERSATION_PERMISSION_HOOK_EVENT;
  process.env.RELAY_HELD_REPLY = JSON.stringify(permissionReplyFor('pi', 'deny', 'Run npm run clean instead'));
  const { handlers } = await loadExtensionWithRelayLog(folder);
  const waitForChat = (_title: string, _body: string, { signal }: { signal: AbortSignal }) => new Promise<boolean>((resolve) => signal.addEventListener('abort', () => resolve(false), { once: true }));
  const context: FakePiContext = { hasUI: true, sessionManager: { getSessionId: () => 'pi-session' }, ui: { confirm: waitForChat } };
  const decision = await handlers.get('tool_call')?.({ toolName: 'bash', input: { command: 'rm -rf build' } }, context);
  assert.deepEqual(decision, { block: true, reason: 'Run npm run clean instead' });
});

test('pi launches the extension file its generated home writes', (t) => {
  const injection = pi.hooks.injection as GeneratedHomeInjection;
  const prepared = injection.prepareHome(process.env, { listenerPort: 4321, folderTrustRoot: os.tmpdir(), isCleanHome: false, packSkillDirs: ['/skills/review'] });
  assert.ok(!('refusal' in prepared));
  t.after(() => fs.rmSync(prepared.home, { recursive: true, force: true }));
  const args = pi.buildArgs({ resumeSessionId: 'pi-session' });
  assert.equal(args[0], '-e');
  assert.ok(fs.readFileSync(args[1] ?? '', 'utf8').includes('agent_settled'));
  assert.deepEqual(JSON.parse(prepared.homeEnvValue ?? '{}'), { mcpUrl: 'http://127.0.0.1:4321/mcp', skillPaths: ['/skills/review'] });
  assert.deepEqual(args.slice(2), ['--session', 'pi-session']);
});

test('pi with no provider logged in lists no models rather than an unreadable list', () => {
  assert.deepEqual(parsePiModels('No models available. Use /login to log into a provider via OAuth or API key.\n'), []);
});
