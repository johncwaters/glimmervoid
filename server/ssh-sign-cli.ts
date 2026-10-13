import fs from 'node:fs/promises';
import path from 'node:path';

import { execFileAsync, spawn } from './child-process-safe.ts';
import { postToAgentIngress } from './agent-api-cli.ts';
import { COMMIT_SIGNING_SHIM_NAME, parseSshPublicKey } from './core/ssh-signing-core.ts';
import { isLoopbackHostname } from '../shared/loopback-hosts.ts';
import { SIGN_URL_ENV, SshSignReply } from '../shared/contracts/session.ts';
import { errorMessage } from '../shared/text.ts';

const SIGN_PATH_PREFIX = '/sign/';
const DEFAULT_SSH_SIGNING_PROGRAM = 'ssh-keygen';
const SIGNING_PROGRAM_LOOKUP_TIMEOUT_MS = 5000;
const OPTIONS_TAKING_A_VALUE: ReadonlySet<string> = new Set(['-Y', '-n', '-f', '-I', '-s', '-O']);

interface SignInvocation {
  namespace: string;
  keyFile: string;
  bufferFile: string;
}

function readSignInvocation(args: readonly string[]): SignInvocation | null {
  const optionValues = new Map<string, string>();
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    if (OPTIONS_TAKING_A_VALUE.has(argument)) {
      optionValues.set(argument, args[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (!argument.startsWith('-')) operands.push(argument);
  }
  const namespace = optionValues.get('-n');
  const keyFile = optionValues.get('-f');
  const bufferFile = operands.at(-1);
  if (optionValues.get('-Y') !== 'sign' || !namespace || !keyFile || operands.length !== 1 || !bufferFile) return null;
  return { namespace, keyFile, bufferFile };
}

function signEndpoint(rawUrl: string | undefined): { endpoint: URL; token: string } | null {
  if (!rawUrl) return null;
  try {
    const endpoint = new URL(rawUrl);
    if (endpoint.protocol !== 'http:' || !isLoopbackHostname(endpoint.hostname) || !endpoint.pathname.startsWith(SIGN_PATH_PREFIX)) return null;
    const token = endpoint.searchParams.get('t') || '';
    endpoint.search = '';
    return { endpoint, token };
  } catch {
    return null;
  }
}

function parseSignReply(text: string): SshSignReply {
  const unanswered = { ok: false as const, error: `Glimmervoid did not answer the signing request: ${text.slice(0, 200)}` };
  try {
    const parsed = SshSignReply.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : unanswered;
  } catch {
    return unanswered;
  }
}

async function operatorSigningProgram(env: NodeJS.ProcessEnv): Promise<string> {
  const envWithoutInjectedConfig = Object.fromEntries(Object.entries(env).filter(([name]) => name !== 'GIT_CONFIG_PARAMETERS'));
  const configuredProgram = await execFileAsync('git', ['config', '--type=path', '--get', 'gpg.ssh.program'], {
    env: envWithoutInjectedConfig, timeout: SIGNING_PROGRAM_LOOKUP_TIMEOUT_MS, encoding: 'utf8',
  }).then(({ stdout }) => stdout.trim(), () => '');
  if (!configuredProgram || path.basename(configuredProgram) === COMMIT_SIGNING_SHIM_NAME) return DEFAULT_SSH_SIGNING_PROGRAM;
  return configuredProgram;
}

function runSigningProgram(program: string, args: readonly string[], { captureStderr }: { captureStderr: boolean }): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, [...args], { stdio: ['inherit', 'inherit', captureStderr ? 'pipe' : 'inherit'] });
    const stderrChunks: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => { stderrChunks.push(chunk); });
    child.on('error', (error) => resolve({ exitCode: 127, stderr: errorMessage(error) }));
    child.on('close', (exitCode) => resolve({ exitCode: exitCode ?? 1, stderr: Buffer.concat(stderrChunks).toString('utf8').trim() }));
  });
}

async function runSshSignCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const invocation = readSignInvocation(args);
  const target = signEndpoint(env[SIGN_URL_ENV]);
  const publicKeyText = invocation && target ? await fs.readFile(invocation.keyFile, 'utf8').catch(() => '') : '';
  const publicKey = parseSshPublicKey(publicKeyText);
  const signingProgram = await operatorSigningProgram(env);
  if (!invocation || !target || !publicKey) return (await runSigningProgram(signingProgram, args, { captureStderr: false })).exitCode;
  const localAttempt = env.SSH_AUTH_SOCK ? await runSigningProgram(signingProgram, args, { captureStderr: true }) : null;
  if (localAttempt?.exitCode === 0) return 0;
  const payload = await fs.readFile(invocation.bufferFile);
  const reply = await postToAgentIngress({
    endpoint: target.endpoint,
    token: target.token,
    body: { namespace: invocation.namespace, publicKey: publicKeyText, payload: payload.toString('base64') },
  }).then((answer) => parseSignReply(answer.text), (error: unknown): SshSignReply => ({ ok: false, error: `Glimmervoid did not answer the signing request: ${errorMessage(error)}` }));
  if (reply.ok) {
    await fs.writeFile(`${invocation.bufferFile}.sig`, reply.signature);
    return 0;
  }
  if (localAttempt?.stderr) console.error(localAttempt.stderr);
  console.error(`glimmervoid: ${reply.error}`);
  return 1;
}

export { runSshSignCli };
