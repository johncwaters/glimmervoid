import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { parsePresentedCredential } from '../../mcp/core/credentials.ts';
import { BRANCH_PROMPT_PREFIX } from '../../shared/board-branch-core.ts';
import {
  BOARD_ASK_QUESTION,
  LONG_CHECKOUT_REPLY,
  RESUMED_AFTER_QUESTION_TEXT,
  SHOWN_CARD_SVG,
  SHOWN_PAGE_FILE_NAME,
  SHOWN_PAGE_HTML,
  SHOWN_PAGE_REPLY,
  SHOW_CARD_BELOW_COMMAND,
} from './cases-core.ts';
import { FAKE_PR_NUMBER, FAKE_PR_URL } from './fake-pr.ts';

type JsonRpcId = number | string;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

const BOARD_ANSWER_PREFIX = 'Answer to your board question';
const BRANCH_FOLLOW_UP = 'branch-follow-up';
const BRANCH_DRAFT_REQUEST = 'Draft refunds';
const GIT_IDENTITY_ARGS = ['-c', 'user.name=Fake Agent', '-c', 'user.email=fake-agent@localhost', '-c', 'commit.gpgsign=false'];

let sessionId: string = randomUUID();
let sessionCwd = process.cwd();
let mcpAuthHeader = '';
let nextClientRequestId = 1;
let openPromptId: JsonRpcId | null = null;
let openPromptWasNarrating = false;
const pendingClientReplies = new Map<JsonRpcId, (replyPayload: unknown) => void>();
let currentModel = 'default';
let currentEffort = 'medium';

function configOptions() {
  return [
    {
      id: 'model',
      category: 'model',
      name: 'Model',
      currentValue: currentModel,
      options: [
        { value: 'default', name: 'Default' },
        { value: 'fast', name: 'Fast' },
      ],
    },
    {
      id: 'effort',
      category: 'thought_level',
      name: 'Effort',
      currentValue: currentEffort,
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    },
  ];
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function sendUpdate(update: Record<string, unknown>): void {
  send({ method: 'session/update', params: { sessionId, update } });
}

function sendAssistantText(text: string): void {
  sendUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  });
}

function sendToolCall(toolName: string, rawInput: Record<string, unknown>, rawOutput?: unknown): void {
  const toolCallId = `toolu_${randomUUID().replaceAll('-', '')}`;
  sendUpdate({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: toolName,
    kind: toolName === 'Edit' ? 'edit' : 'execute',
    status: 'in_progress',
    rawInput,
    _meta: { claudeCode: { toolName } },
  });
  if (rawOutput === undefined) return;
  sendUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    rawOutput,
  });
}

function requestClient(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = `fake-acp-${nextClientRequestId++}`;
  return new Promise((resolve) => {
    pendingClientReplies.set(id, resolve);
    send({ id, method, params });
  });
}

function captureMcpAuthHeader(params: Record<string, unknown> | undefined): void {
  const servers = params?.mcpServers;
  if (!Array.isArray(servers)) return;
  for (const server of servers) {
    if (typeof server !== 'object' || server === null) continue;
    const headers = Reflect.get(server, 'headers');
    if (!Array.isArray(headers)) continue;
    for (const header of headers) {
      if (typeof header !== 'object' || header === null) continue;
      if (String(Reflect.get(header, 'name') ?? '').toLowerCase() !== 'authorization') continue;
      const value = Reflect.get(header, 'value');
      if (typeof value !== 'string' || value.length === 0) continue;
      const parsed = parsePresentedCredential(value);
      mcpAuthHeader = parsed ? `Bearer ${parsed.secret}` : value;
    }
  }
}

async function postAgentVerb(verb: string, body: Record<string, unknown>): Promise<void> {
  const agentUrl = process.env.GLIMMERVOID_AGENT_URL;
  if (!agentUrl) return;
  const parsed = new URL(agentUrl);
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/${verb}`;
  const token = parsed.searchParams.get('t') ?? '';
  parsed.searchParams.delete('t');
  const authHeader = token ? `Bearer ${token}` : mcpAuthHeader;
  await fetch(parsed.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authHeader ? { authorization: authHeader } : {}) },
    body: JSON.stringify(body),
  }).catch(() => {});
}

function commitRefunds(): void {
  fs.mkdirSync(path.join(sessionCwd, 'src', 'payments'), { recursive: true });
  fs.writeFileSync(
    path.join(sessionCwd, 'src', 'payments', 'refund-policy.js'),
    "export function refund(charge) {\n  return { ...charge, refunded: true };\n}\n",
  );
  execFileSync('git', ['add', 'src/payments/refund-policy.js'], { cwd: sessionCwd, stdio: 'ignore' });
  execFileSync('git', [...GIT_IDENTITY_ARGS, 'commit', '--no-verify', '-m', 'Add refunds beside the card module'], { cwd: sessionCwd, stdio: 'ignore' });
}

function promptTextOf(params: Record<string, unknown> | undefined): string {
  const blocks = params?.prompt;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .flatMap((block) => (typeof block === 'object' && block !== null && Reflect.get(block, 'type') === 'text' && typeof Reflect.get(block, 'text') === 'string'
      ? [String(Reflect.get(block, 'text'))]
      : []))
    .join('\n')
    .trim();
}

async function handlePrompt(id: JsonRpcId, command: string): Promise<void> {
  if (command === 'narrate') {
    for (const testRun of [1, 2, 3]) {
      sendAssistantText('Running.');
      sendToolCall('Bash', { command: `npm test -- run-${testRun}` }, 'ok');
    }
    sendAssistantText('Build passed. The rail now shows the agent logo and the meters color by level, so next I check the board.');
    sendToolCall('Bash', { command: 'npm run build' }, 'ok');
    sendAssistantText('Checking the board.');
    sendToolCall('Bash', { command: 'npm run board' }, 'ok');
    openPromptId = id;
    openPromptWasNarrating = true;
    return;
  }
  if (command === 'delegate') {
    sendToolCall('Task', { subagent_type: 'Explore', description: 'Find the tax table' });
    openPromptId = id;
    openPromptWasNarrating = true;
    return;
  }
  if (command === 'work') {
    sendToolCall('Bash', { command: 'npm test' });
    openPromptId = id;
    openPromptWasNarrating = false;
    return;
  }
  if (command === 'edit-shop') {
    sendToolCall('Edit', { file_path: 'src/checkout/checkout.js', old_string: 'a', new_string: 'b' }, 'ok');
    sendAssistantText('The charge goes through src/payments/card.js, so I left it alone.');
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (command === 'long-shop') {
    sendToolCall('Edit', { file_path: 'src/checkout/checkout.js', old_string: 'a', new_string: 'b' }, 'ok');
    sendAssistantText(LONG_CHECKOUT_REPLY);
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (command === 'Where does tax get added?') {
    sendAssistantText('Tax is added in src/checkout/checkout.js.');
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (command.startsWith(BOARD_ANSWER_PREFIX)) {
    sendAssistantText('Noted.');
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (command.startsWith(BRANCH_PROMPT_PREFIX) && command.endsWith(BRANCH_DRAFT_REQUEST)) {
    fs.mkdirSync(path.join(sessionCwd, 'src', 'payments'), { recursive: true });
    fs.writeFileSync(path.join(sessionCwd, 'src', 'payments', 'refund-draft.js'), 'export const draft = true;\n');
    sendAssistantText('Drafted refunds, not committed yet.');
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (command.startsWith(BRANCH_PROMPT_PREFIX)) {
    commitRefunds();
    sendAssistantText('Committed refunds in src/payments/refund-policy.js.');
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (command === BRANCH_FOLLOW_UP) {
    sendAssistantText('Refunds reuse the charge from src/payments/card.js.');
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (command === 'ask-shop') {
    await postAgentVerb('whiteboard', {
      sub: 'ask',
      about: 'src/payments/card.js',
      question: BOARD_ASK_QUESTION,
      options: ['Yes, reuse it', 'No, keep them apart'],
    });
    sendAssistantText('Asked on the board.');
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (command === 'show-page') {
    const pagePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shown-page-')), SHOWN_PAGE_FILE_NAME);
    fs.writeFileSync(pagePath, SHOWN_PAGE_HTML);
    sendToolCall('mcp__glimmervoid__whiteboard', { action: 'show', path: pagePath }, 'ok');
    await postAgentVerb('whiteboard', { sub: 'show', path: pagePath });
    sendAssistantText(SHOWN_PAGE_REPLY);
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (command.startsWith(SHOW_CARD_BELOW_COMMAND)) {
    const cardPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shown-card-')), 'refund-flow.svg');
    fs.writeFileSync(cardPath, SHOWN_CARD_SVG);
    sendToolCall('mcp__glimmervoid__whiteboard', { action: 'show', path: cardPath }, 'ok');
    await postAgentVerb('whiteboard', {
      sub: 'show',
      path: cardPath,
      near: { of: command.slice(SHOW_CARD_BELOW_COMMAND.length).trim(), side: 'bottom' },
    });
    sendAssistantText('Shown below the card.');
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (command === 'ask-question-resume') {
    await requestClient('elicitation/create', {
      sessionId,
      mode: 'form',
      message: 'Which rollout?',
      requestedSchema: {
        type: 'object',
        properties: {
          answer: {
            type: 'string',
            title: 'Which rollout?',
            oneOf: [
              { const: 'Move now', title: 'Move now', description: 'The old path stops today' },
              { const: 'Run both for a week (Recommended)', title: 'Run both for a week (Recommended)', description: 'The old path stays as a fallback' },
            ],
          },
          answer_other: { type: 'string' },
        },
      },
    });
    sendAssistantText(RESUMED_AFTER_QUESTION_TEXT);
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (command === 'open-pr') {
    sendToolCall('Bash', { command: 'gh pr create --draft --fill' }, { stdout: FAKE_PR_URL, gitOperation: { pr: { action: 'created', url: FAKE_PR_URL } } });
    sendAssistantText(`Opened ${FAKE_PR_URL}`);
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (command === 'mark-pr-ready') {
    sendToolCall('Bash', { command: `gh pr ready ${FAKE_PR_NUMBER}` }, { stdout: '' });
    sendAssistantText(`Marked #${FAKE_PR_NUMBER} ready.`);
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (command === 'stall-fail') {
    process.exit(1);
  }
  sendAssistantText('Done.');
  send({ id, result: { stopReason: 'end_turn' } });
}

function handleMessage(message: JsonRpcMessage): void {
  if (message.method === undefined && message.id !== undefined) {
    const resolve = pendingClientReplies.get(message.id);
    if (!resolve) return;
    pendingClientReplies.delete(message.id);
    resolve(message.result);
    return;
  }
  if (message.method === 'initialize' && message.id !== undefined) {
    send({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: 'fake-acp-agent', version: '1.0.0' },
      },
    });
    return;
  }
  if (message.method === 'session/new' && message.id !== undefined) {
    sessionId = randomUUID();
    if (typeof message.params?.cwd === 'string') sessionCwd = message.params.cwd;
    captureMcpAuthHeader(message.params);
    send({
      id: message.id,
      result: {
        sessionId,
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
        configOptions: configOptions(),
      },
    });
    return;
  }
  if (message.method === 'session/load' && message.id !== undefined) {
    if (typeof message.params?.sessionId === 'string') sessionId = message.params.sessionId;
    if (typeof message.params?.cwd === 'string') sessionCwd = message.params.cwd;
    captureMcpAuthHeader(message.params);
    send({
      id: message.id,
      result: {
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
        configOptions: configOptions(),
      },
    });
    return;
  }
  if (message.method === 'session/set_mode' && message.id !== undefined) {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'session/set_config_option' && message.id !== undefined) {
    const configId = message.params?.configId;
    const value = message.params?.value;
    if (configId === 'model' && typeof value === 'string') currentModel = value;
    if (configId === 'effort' && typeof value === 'string') currentEffort = value;
    const nextOptions = configOptions();
    sendUpdate({ sessionUpdate: 'config_option_update', configOptions: nextOptions });
    send({ id: message.id, result: { configOptions: nextOptions } });
    return;
  }
  if (message.method === 'session/cancel') {
    if (openPromptId === null) return;
    const cancelledId = openPromptId;
    const wasNarrating = openPromptWasNarrating;
    openPromptId = null;
    openPromptWasNarrating = false;
    if (wasNarrating) sendAssistantText('All green.');
    send({ id: cancelledId, result: { stopReason: 'cancelled' } });
    return;
  }
  if (message.method === 'session/prompt' && message.id !== undefined) {
    void handlePrompt(message.id, promptTextOf(message.params));
  }
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line.trim().length === 0) return;
  handleMessage(JSON.parse(line) as JsonRpcMessage);
});
input.on('close', () => { process.exit(0); });
