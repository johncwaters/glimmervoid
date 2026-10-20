import path from 'node:path';
import type { AgentLoginStatus, ConnectableAgent } from '../../../shared/contracts/control-messages.ts';

const CONNECT_TIMEOUT_MS = 16 * 60 * 1000;
const CONNECT_OUTPUT_LIMIT = 64 * 1024;
const PASTED_CODE_LIMIT = 512;

type LoginSource = 'host' | 'glimmervoid';

interface ConnectRecipe {
  loginArgs: string[];
  homeEnvKey: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME';
  homeFolderName: string;
  displayName: string;
}

const CONNECT_RECIPES: Readonly<Record<ConnectableAgent, ConnectRecipe>> = Object.freeze({
  'claude-code': { loginArgs: ['auth', 'login', '--claudeai'], homeEnvKey: 'CLAUDE_CONFIG_DIR', homeFolderName: 'claude-code', displayName: 'Claude Code' },
  codex: { loginArgs: ['login', '--device-auth'], homeEnvKey: 'CODEX_HOME', homeFolderName: 'codex', displayName: 'Codex' },
});

const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const OSC_SEQUENCE = new RegExp(`${ESCAPE}\\][^${BELL}${ESCAPE}]*(?:${BELL}|${ESCAPE}\\\\)`, 'g');
const CSI_SEQUENCE = new RegExp(`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, 'g');
const URL_PATTERN = new RegExp(`https://[^\\s"'<>${BELL}${ESCAPE}]+`, 'g');
const DEVICE_CODE_PATTERN = /\b[A-Z0-9]{4,5}-[A-Z0-9]{4,6}\b/;

interface ConnectPrompt {
  verificationUrl: string | null;
  userCode: string | null;
  needsPastedCode: boolean;
}

function connectHomeDir(loginsRoot: string, agent: ConnectableAgent): string {
  return path.join(loginsRoot, CONNECT_RECIPES[agent].homeFolderName);
}

function appendConnectOutput(previousOutput: string, chunk: string): string {
  const combined = previousOutput + chunk;
  return combined.length > CONNECT_OUTPUT_LIMIT ? combined.slice(-CONNECT_OUTPUT_LIMIT) : combined;
}

function urlsIn(text: string): string[] {
  return [...text.matchAll(URL_PATTERN)].map(([url]) => url.replace(/[.,;)]+$/, ''));
}

function isVerificationUrl(agent: ConnectableAgent, url: string): boolean {
  if (agent === 'codex') return url.startsWith('https://auth.openai.com/');
  return url.includes('/oauth/authorize');
}

function readConnectPrompt(agent: ConnectableAgent, output: string): ConnectPrompt {
  const withoutCsi = output.replace(CSI_SEQUENCE, '');
  const urlInHyperlinks = urlsIn(withoutCsi).find((url) => isVerificationUrl(agent, url)) ?? null;
  const visibleText = withoutCsi.replace(OSC_SEQUENCE, '');
  if (agent === 'codex') {
    const afterCodeHeading = visibleText.split(/one-time code/i)[1] ?? '';
    return { verificationUrl: urlInHyperlinks, userCode: afterCodeHeading.match(DEVICE_CODE_PATTERN)?.[0] ?? null, needsPastedCode: false };
  }
  return { verificationUrl: urlInHyperlinks, userCode: null, needsPastedCode: /paste code here/i.test(visibleText) };
}

function isControlCharacter(character: string): boolean {
  const codePoint = character.charCodeAt(0);
  return codePoint < 32 || codePoint === 127;
}

function pastedCodeRefusal(code: string): string | null {
  const trimmed = code.trim();
  if (!trimmed) return 'Paste the code the sign-in page showed.';
  if (trimmed.length > PASTED_CODE_LIMIT) return 'That code is too long to be a sign-in code.';
  if ([...trimmed].some(isControlCharacter)) return 'That code contains control characters.';
  return null;
}

function idleLoginStatus(agent: ConnectableAgent, source: LoginSource | null): AgentLoginStatus {
  return {
    agent,
    state: source ? 'signed-in' : 'signed-out',
    source,
    verificationUrl: null,
    userCode: null,
    needsPastedCode: false,
    reason: null,
  };
}

function pastedCodeRejection(agent: ConnectableAgent, outputSincePastedCode: string | null): string | null {
  if (outputSincePastedCode === null) return null;
  if (!/invalid code/i.test(outputSincePastedCode.replace(CSI_SEQUENCE, ''))) return null;
  return `${CONNECT_RECIPES[agent].displayName} did not accept that code. Copy the whole code from the sign-in page and paste it again.`;
}

function connectingStatus(agent: ConnectableAgent, prompt: ConnectPrompt, reason: string | null): AgentLoginStatus {
  return { agent, state: 'connecting', source: null, ...prompt, reason };
}

function failedStatus(agent: ConnectableAgent, reason: string): AgentLoginStatus {
  return { agent, state: 'failed', source: null, verificationUrl: null, userCode: null, needsPastedCode: false, reason };
}

function decideConnectExit({ agent, exitCode, source, wasCancelled, hasTimedOut }: {
  agent: ConnectableAgent;
  exitCode: number;
  source: LoginSource | null;
  wasCancelled: boolean;
  hasTimedOut: boolean;
}): AgentLoginStatus {
  const { displayName } = CONNECT_RECIPES[agent];
  if (source === 'glimmervoid') return idleLoginStatus(agent, source);
  if (hasTimedOut) return failedStatus(agent, `The ${displayName} sign-in was not finished within ${CONNECT_TIMEOUT_MS / 60_000} minutes. Connect again to get a new code.`);
  if (wasCancelled) return idleLoginStatus(agent, source);
  if (exitCode === 0) return failedStatus(agent, `${displayName} finished signing in but left no login Glimmervoid can read.`);
  return failedStatus(agent, `${displayName} sign-in stopped with exit code ${exitCode}. Connect again to retry.`);
}

export {
  CONNECT_RECIPES, CONNECT_TIMEOUT_MS, appendConnectOutput, connectHomeDir, connectingStatus, decideConnectExit, idleLoginStatus,
  pastedCodeRefusal, pastedCodeRejection, readConnectPrompt,
};
export type { LoginSource };
