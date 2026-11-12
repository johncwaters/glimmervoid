import path from 'node:path';
import type { AgentLoginStatus, ConnectableAgent } from '../../../shared/contracts/control-messages.ts';

const CONNECT_TIMEOUT_MS = 16 * 60 * 1000;
const CONNECT_OUTPUT_LIMIT = 64 * 1024;
const PASTED_CODE_LIMIT = 512;

type LoginSource = 'host' | 'glimmervoid';

interface ConnectRecipe {
  loginArgs: string[];
  statusArgs: string[];
  logoutArgs: string[];
  homeEnvKey: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME';
  credentialEnvKeys: readonly string[];
  homeFolderName: string;
  displayName: string;
}

const CONNECT_RECIPES: Readonly<Record<ConnectableAgent, ConnectRecipe>> = Object.freeze({
  'claude-code': { loginArgs: ['auth', 'login', '--claudeai'], statusArgs: ['auth', 'status'], logoutArgs: ['auth', 'logout'], homeEnvKey: 'CLAUDE_CONFIG_DIR', credentialEnvKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN'], homeFolderName: 'claude-code', displayName: 'Claude Code' },
  codex: { loginArgs: ['login', '--device-auth'], statusArgs: ['login', 'status'], logoutArgs: ['logout'], homeEnvKey: 'CODEX_HOME', credentialEnvKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'], homeFolderName: 'codex', displayName: 'Codex' },
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

interface AccountIdentity {
  isChecked: boolean;
  isSignedIn: boolean;
  label: string | null;
  detail: string | null;
}

function textField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function capitalized(word: string): string {
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

function readClaudeIdentity(statusOutput: string): AccountIdentity {
  const unchecked: AccountIdentity = { isChecked: false, isSignedIn: false, label: null, detail: null };
  const signedOut: AccountIdentity = { isChecked: true, isSignedIn: false, label: null, detail: null };
  const parsed: unknown = (() => {
    try {
      return JSON.parse(statusOutput);
    } catch {
      return null;
    }
  })();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unchecked;
  const status = Object.fromEntries(Object.entries(parsed));
  if (status.loggedIn !== true) return signedOut;
  const orgName = textField(status, 'orgName');
  const plan = textField(status, 'subscriptionType');
  const email = textField(status, 'email');
  const isPersonalOrg = orgName !== null && email !== null && orgName === `${email}'s Organization`;
  const label = [isPersonalOrg ? 'Personal' : orgName, plan === null ? null : capitalized(plan)].filter((part) => part !== null).join(' ');
  return { isChecked: true, isSignedIn: true, label: label === '' ? email : label, detail: email };
}

function readAccountIdentity(agent: ConnectableAgent, statusOutput: string, exitCode: number | null): AccountIdentity {
  if (agent === 'claude-code') return readClaudeIdentity(statusOutput);
  return { isChecked: exitCode !== null, isSignedIn: exitCode === 0, label: null, detail: statusOutput.trim().split('\n')[0] || null };
}

export {
  CONNECT_RECIPES, readAccountIdentity, CONNECT_TIMEOUT_MS, appendConnectOutput, connectHomeDir, connectingStatus, decideConnectExit, idleLoginStatus,
  pastedCodeRefusal, pastedCodeRejection, readConnectPrompt,
};
export type { AccountIdentity, LoginSource };
