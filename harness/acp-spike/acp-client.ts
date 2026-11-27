import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

export const SDK_VERSION = '2.12.0';
export const SDK_PACKAGE = '@agentclientprotocol/sdk';
export const DEPS_DIR = process.env.ACP_SPIKE_DEPS ?? join(homedir(), '.cache', 'glimmervoid-acp-spike');

export type AgentName = 'claude' | 'codex' | 'antigravity';

export const LAUNCH_BY_AGENT: Record<AgentName, { command: string; args: string[] }> = {
  claude: { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp@0.112.0'] },
  codex: { command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp@2.12.0'] },
  antigravity: { command: 'agy', args: ['acp'] },
};

const ENV_NAMES_STRIPPED_FROM_AGENT = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];

export async function loadSdk() {
  const entry = join(DEPS_DIR, 'node_modules', '@agentclientprotocol', 'sdk', 'dist', 'v1', 'stable', 'acp.js');
  return import(pathToFileURL(entry).href).catch((error: unknown) => {
    throw new Error(
      `ACP SDK missing at ${entry}: run npm install --no-save --no-package-lock --prefix ${DEPS_DIR} ${SDK_PACKAGE}@${SDK_VERSION} (${String(error)})`,
    );
  });
}

const secretValues = [process.env.GLIMMERVOID_MCP_TOKEN, process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY, process.env.GEMINI_API_KEY]
  .filter((value): value is string => typeof value === 'string' && value.length >= 8);

const osUserName = userInfo().username;

export function redact(text: string): string {
  const withoutKnownSecrets = secretValues.reduce((current, secret) => current.split(secret).join('<redacted:secret>'), text);
  return withoutKnownSecrets
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '<redacted:email>')
    .split(homedir())
    .join('~')
    .split(osUserName)
    .join('<user>')
    .replace(/("kind"\s*:\s*"account"\s*,\s*"(?:label|plan)"\s*:\s*")[^"]*"/g, '$1<redacted:account>"')
    .replace(/("label"\s*:\s*")[^"]*("\s*,\s*"(?:active|account)")/g, '$1<redacted:account>$2')
    .replace(/("account"\s*:\s*\{[^}]*?"plan"\s*:\s*")[^"]*"/g, '$1<redacted:account>"')
    .replace(/Bearer [A-Za-z0-9._~+/=-]+/g, 'Bearer <redacted:token>')
    .replace(/([?&]t=)[0-9a-f]{16,}/g, '$1<redacted:token>')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<redacted:jwt>')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '<redacted:key>')
    .replace(/("organization"\s*:\s*")[^"]*"/g, '$1<redacted:account>"')
    .replace(/(\\"organization\\"\s*:\s*\\")[^"\\]*\\"/g, '$1<redacted:account>\\"');
}

export type RecordedDirection = 'client->agent' | 'agent->client' | 'note';

export function createRecorder(recordingPath: string) {
  mkdirSync(dirname(recordingPath), { recursive: true });
  const startedAtMs = Date.now();
  return {
    write(direction: RecordedDirection, line: string) {
      const elapsedMs = Date.now() - startedAtMs;
      const parsed = safeParse(redact(line));
      appendFileSync(recordingPath, `${JSON.stringify({ elapsedMs, direction, message: parsed })}\n`);
    },
    note(text: string) {
      appendFileSync(recordingPath, `${JSON.stringify({ elapsedMs: Date.now() - startedAtMs, direction: 'note', message: redact(text) })}\n`);
    },
  };
}

export type Recorder = ReturnType<typeof createRecorder>;

function safeParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
}

function lineTap(recorder: Recorder, direction: RecordedDirection) {
  let pending = '';
  const decoder = new TextDecoder();
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length > 0) recorder.write(direction, line);
      }
    },
  });
}

export type LaunchedAgent = {
  child: ChildProcessWithoutNullStreams;
  stderrLines: string[];
  exited: Promise<number | null>;
};

export function launchAgent(agent: AgentName, cwd: string, recorder: Recorder, extraEnv: Record<string, string> = {}): LaunchedAgent {
  const launch = LAUNCH_BY_AGENT[agent];
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || ENV_NAMES_STRIPPED_FROM_AGENT.includes(name)) continue;
    env[name] = value;
  }
  const child = spawn(launch.command, launch.args, { cwd, env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  recorder.note(`launch ${launch.command} ${launch.args.join(' ')} pid=${child.pid}`);
  const stderrLines: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text: string) => {
    for (const line of text.split('\n')) {
      if (line.trim().length > 0) stderrLines.push(redact(line));
    }
  });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, stderrLines, exited };
}

export function tappedStreams(launched: LaunchedAgent, recorder: Recorder) {
  const agentStdout = Readable.toWeb(launched.child.stdout) as ReadableStream<Uint8Array>;
  const agentStdin = Writable.toWeb(launched.child.stdin) as WritableStream<Uint8Array>;
  const fromAgent = agentStdout.pipeThrough(lineTap(recorder, 'agent->client'));
  const toAgentTap = lineTap(recorder, 'client->agent');
  toAgentTap.readable.pipeTo(agentStdin).catch(() => undefined);
  return { output: toAgentTap.writable, input: fromAgent };
}
