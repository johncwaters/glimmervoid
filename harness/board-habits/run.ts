import '../support/git-local-env.ts';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { runCommandSafely } from '../../server/child-process-safe.ts';
import { selectionArgs } from '../../shared/agent-models-core.ts';
import { DEFAULT_MODELS } from '../../shared/contracts/agent-models.ts';
import { habitTableOf, TrialResult } from './habits-core.ts';
import type { ToolCall, TurnResult } from './habits-core.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const TURN_TIMEOUT_MS = 25 * 60_000;
const TRIAL_TIMEOUT_MS = 2 * 60 * 60_000;
const STREAM_BUFFER_BYTES = 256 * 1024 * 1024;
const RESULT_TEXT_HEAD = 600;
const MAX_AGENT_TURNS = '60';
const PICTURE_SCALE = 2;
const OPERATOR_EDIT_BOX_ID = 'operator-edit';
const SCRUBBED_ENV_KEY = /^(GLIMMERVOID_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_COMMIT_POLICY_ROOT$)/;

interface BoardTask {
  id: string;
  turns: string[];
  operatorEditBeforeTurn?: number;
}

const TASKS: readonly BoardTask[] = [
  {
    id: 'revise-chart',
    turns: [
      'Make a small bar chart of daily signups (Mon 3, Tue 5, Wed 2) and show it to me on the Glimmervoid board.',
      'Correction: Wed was actually 7, not 2. Update the chart on the board.',
      'Thursday came in at 4 signups. Add it.',
      'Actually a line chart reads better for a trend. Switch it to a line chart.',
    ],
  },
  {
    id: 'revise-renamed',
    turns: [
      'Make a chart of quarterly revenue in $M (Q1 4, Q2 6, Q3 5, Q4 8) and show it to me on the Glimmervoid board.',
      'Q3 was restated to 9. Keep the original file untouched for the audit trail, save the corrected chart as a new file, and show me the corrected one on the board.',
      'Finance wants the Q4 bar highlighted as the record quarter. Do that.',
    ],
  },
  {
    id: 'explain-flow',
    turns: [
      'Explain on the Glimmervoid whiteboard how a web request flows through a typical web app: browser, CDN, load balancer, app server, cache and database.',
      'Add a message queue between the app server and a background worker that writes to the database, and update the board.',
      'Our cache is Redis with LRU eviction. Reflect that on the board.',
      'Now show what happens on a cache miss.',
    ],
  },
  {
    id: 'operator-edit',
    turns: [
      'Draw our checkout flow on the Glimmervoid whiteboard: cart, payment, order service and confirmation email.',
      'Add a fraud check between payment and the order service.',
      'Tidy up the board layout so it reads well.',
    ],
    operatorEditBeforeTurn: 1,
  },
  {
    id: 'second-topic',
    turns: [
      'Draw how our login works on the Glimmervoid whiteboard: browser, auth service and session store.',
      'Separately, sketch our nightly backup job on the whiteboard: database, snapshot and S3.',
    ],
  },
];

interface Arm {
  name: string;
  root: string;
}

function armOf(spec: string): Arm {
  const separatorIndex = spec.indexOf('=');
  if (separatorIndex <= 0) throw new Error(`--arm takes name=path, got ${spec}`);
  return { name: spec.slice(0, separatorIndex), root: path.resolve(spec.slice(separatorIndex + 1)) };
}

function toolCallsOf(streamLines: readonly string[]): ToolCall[] {
  const callsById = new Map<string, ToolCall>();
  for (const line of streamLines) {
    const event = parsedLineOf(line);
    const contentParts: unknown = event?.message?.content;
    if (!Array.isArray(contentParts)) continue;
    for (const part of contentParts) {
      if (part.type === 'tool_use' && typeof part.id === 'string') callsById.set(part.id, { name: String(part.name), input: part.input, isError: false, resultText: '' });
      const answeredCall = part.type === 'tool_result' ? callsById.get(String(part.tool_use_id)) : undefined;
      if (!answeredCall) continue;
      answeredCall.isError = part.is_error === true;
      answeredCall.resultText = (typeof part.content === 'string' ? part.content : JSON.stringify(part.content)).slice(0, RESULT_TEXT_HEAD);
    }
  }
  return [...callsById.values()];
}

function parsedLineOf(line: string): { type?: string; is_error?: boolean; total_cost_usd?: number; result?: string; message?: { content?: unknown } } | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function runClaudeTurn(projectDirectory: string, mcpConfigPath: string, credential: string, model: string, prompt: string, isContinuation: boolean): Promise<TurnResult> {
  const args = ['-p', prompt, ...selectionArgs({ agent: 'claude-code', model, options: [] }), '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', mcpConfigPath,
    '--setting-sources', 'project,local', '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__glimmervoid', 'Write', 'Edit', 'Read', 'Bash', 'Glob', 'Grep', '--max-turns', MAX_AGENT_TURNS];
  if (isContinuation) args.push('--continue');
  const scrubbedEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !SCRUBBED_ENV_KEY.test(key)));
  const { stdout, stderr } = await runCommandSafely('claude', args, { cwd: projectDirectory, env: { ...scrubbedEnvironment, GLIMMERVOID_MCP_TOKEN: credential }, timeoutMs: TURN_TIMEOUT_MS, maxBufferBytes: STREAM_BUFFER_BYTES });
  const streamLines = stdout.split('\n').filter(Boolean);
  const toolCalls = toolCallsOf(streamLines);
  const finalEvent = streamLines.map(parsedLineOf).filter((event) => event?.type === 'result').at(-1);
  if (!finalEvent) return { ok: false, costUsd: 0, text: `${stdout.slice(-1500)}\n${stderr}`.slice(0, 2000), toolCalls };
  return { ok: finalEvent.is_error !== true, costUsd: Number(finalEvent.total_cost_usd ?? 0), text: String(finalEvent.result ?? ''), toolCalls };
}

async function runTrial(arm: Arm, task: BoardTask, trialIndex: number, model: string, outDirectory: string): Promise<void> {
  await import(path.join(arm.root, 'harness/support/disable-telemetry.ts'));
  const { createBackend } = await import(path.join(arm.root, 'server/backend/backend.ts'));
  const { boardPictureFile } = await import(path.join(arm.root, 'server/whiteboard/board-picture.ts'));
  const { filePictureLimitsOf } = await import(path.join(arm.root, 'mcp/core/board-reading.ts'));
  const { Op } = await import(path.join(arm.root, 'shared/contracts/whiteboard.ts'));
  const trialDirectory = fs.mkdtempSync(path.join(outDirectory, `${arm.name}-${task.id}-${trialIndex}-`));
  const scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-board-habits-'));
  const projectDirectory = path.join(scratchDirectory, 'project');
  fs.mkdirSync(projectDirectory);
  const sessionId = `habits-${arm.name}-${task.id}-${trialIndex}`;
  const configPath = path.join(scratchDirectory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ projects: [{ id: sessionId, name: 'board habits', path: projectDirectory, agent: 'claude-code', dangerouslySkipPermissions: false }], teams: [], repoRoots: [], autoResume: false, worktree: { autoRebase: false } }));
  process.env.GLIMMERVOID_CONFIG = configPath;
  process.env.GLIMMERVOID_HOME = path.join(scratchDirectory, 'glimmervoid-home');
  const server = http.createServer();
  const backend = createBackend(server, { staticDir: null });
  server.on('request', backend.app);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
  for (let attempt = 0; attempt < 500 && backend.hookPort() === null; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const session = backend.getSession(sessionId);
  const baseUrl = `http://127.0.0.1:${backend.hookPort()}`;
  const callAgent = async (body: Record<string, unknown>) => {
    const response = await fetch(`${baseUrl}/agent/${sessionId}/whiteboard`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.agentToken}` }, body: JSON.stringify(body) });
    return response.json();
  };
  const boardIdsOf = async (): Promise<string[]> => ((await callAgent({ sub: 'list', all: true })).boards ?? []).map((summary: { id: string }) => summary.id);
  const mcpConfigPath = path.join(scratchDirectory, 'mcp.json');
  fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: { glimmervoid: { type: 'http', url: `${baseUrl}/mcp`, headers: { Authorization: `Bearer ${'$'}{GLIMMERVOID_MCP_TOKEN}` } } } }));
  const credential = `${sessionId}.${session.agentToken}`;
  const turnResults: TurnResult[] = [];
  let operatorEditBoxId: string | null = null;
  for (const [turnIndex, prompt] of task.turns.entries()) {
    const editedBoardId = turnIndex === task.operatorEditBeforeTurn ? (await boardIdsOf())[0] : undefined;
    if (editedBoardId) {
      const reply = await backend.whiteboards.handleOperator.put(editedBoardId, [Op.parse({ op: 'add', element: { kind: 'box', id: OPERATOR_EDIT_BOX_ID, title: 'Operator note: PCI scope', shape: 'note', tone: 'yellow', place: 'aside' } })]);
      operatorEditBoxId = reply.ok === false ? null : OPERATOR_EDIT_BOX_ID;
    }
    const turnResult = await runClaudeTurn(projectDirectory, mcpConfigPath, credential, model, prompt, turnIndex > 0);
    turnResults.push(turnResult);
    if (!turnResult.ok) break;
  }
  const boards: unknown[] = [];
  for (const boardId of await boardIdsOf()) {
    const read = await callAgent({ sub: 'get', board: boardId, whole: true });
    boards.push(read.ok && read.board?.elements ? read.board : null);
    const picture = await boardPictureFile(backend.whiteboards.layouts, backend.whiteboards.assets, boardId, { format: 'png', region: null, limits: filePictureLimitsOf(PICTURE_SCALE) }).catch((error: unknown) => ({ ok: false, error: String(error) }));
    if (picture.ok) fs.writeFileSync(path.join(trialDirectory, `board-${boards.length}.png`), picture.bytes);
  }
  const trial = TrialResult.parse({ arm: arm.name, task: task.id, trialIndex, turnResults, boards, operatorEditBoxId });
  fs.writeFileSync(path.join(trialDirectory, 'result.json'), JSON.stringify(trial, null, 2));
  await new Promise((resolve) => server.close(resolve));
  backend.shutdown?.();
  fs.rmSync(scratchDirectory, { recursive: true, force: true });
  console.log(`${arm.name} ${task.id} #${trialIndex}: ok=${turnResults.map((turn) => turn.ok).join(',')} cost=${turnResults.reduce((sum, turn) => sum + turn.costUsd, 0).toFixed(2)}`);
}

function readTrials(outDirectory: string): TrialResult[] {
  return fs.readdirSync(outDirectory, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .map((entry) => path.join(outDirectory, entry.name, 'result.json'))
    .filter((resultPath) => fs.existsSync(resultPath))
    .map((resultPath) => TrialResult.parse(JSON.parse(fs.readFileSync(resultPath, 'utf8'))));
}

async function runTrialInChild(arm: Arm, taskId: string, trialIndex: number, model: string, outDirectory: string): Promise<void> {
  const args = [import.meta.filename, '--trial', `${arm.name}=${arm.root}`, '--tasks', taskId, '--trials', String(trialIndex), '--agent-model', model, '--out', outDirectory];
  const run = await runCommandSafely(process.execPath, args, { cwd: arm.root, env: process.env, timeoutMs: TRIAL_TIMEOUT_MS, maxBufferBytes: STREAM_BUFFER_BYTES });
  process.stdout.write(run.stdout);
  if (!run.ok) process.stderr.write(`${arm.name} ${taskId} #${trialIndex} failed: ${run.stderr.slice(-1500)}\n`);
}

const { values: options } = parseArgs({
  options: {
    arm: { type: 'string', multiple: true },
    trial: { type: 'string' },
    tasks: { type: 'string' },
    trials: { type: 'string', default: '3' },
    'agent-model': { type: 'string', default: DEFAULT_MODELS.boardHabits },
    out: { type: 'string' },
    report: { type: 'string' },
  },
});

if (options.report) {
  console.log(habitTableOf(readTrials(path.resolve(options.report))));
  process.exit(0);
}

const outDirectory = path.resolve(options.out ?? path.join(REPO_ROOT, 'harness/board-habits/out', new Date().toISOString().replaceAll(':', '-')));
fs.mkdirSync(outDirectory, { recursive: true });
const taskIds = options.tasks ? options.tasks.split(',') : TASKS.map((task) => task.id);
const unknownTaskIds = taskIds.filter((taskId) => !TASKS.some((task) => task.id === taskId));
if (unknownTaskIds.length > 0) throw new Error(`no task ${unknownTaskIds.join(', ')}; tasks are ${TASKS.map((task) => task.id).join(', ')}`);

if (options.trial) {
  const task = TASKS.find((candidate) => candidate.id === taskIds[0]);
  if (!task) throw new Error(`no task ${taskIds[0]}`);
  await runTrial(armOf(options.trial), task, Number(options.trials), options['agent-model'], outDirectory);
  process.exit(0);
}

const arms = (options.arm ?? [`head=${REPO_ROOT}`]).map(armOf);
const trialCount = Number(options.trials);
await Promise.all(arms.flatMap((arm) => taskIds.map(async (taskId) => {
  for (let trialIndex = 0; trialIndex < trialCount; trialIndex += 1) await runTrialInChild(arm, taskId, trialIndex, options['agent-model'], outDirectory);
})));
console.log(`\nresults in ${outDirectory}\n`);
console.log(habitTableOf(readTrials(outDirectory)));
