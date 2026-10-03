import { createHash } from 'node:crypto';

import { BUILTIN_AGENT_IDS } from '../../shared/contracts/config.ts';
import type { ClientErrorReport } from '../../shared/contracts/control-messages.ts';
import {
  FeatureFlagsResponse, MAX_AI_MODEL_LENGTH, MAX_AI_PROVIDER_LENGTH, MAX_EXCEPTION_FRAMES, MAX_TEXT_LENGTH, TELEMETRY_KILL_SWITCH_FLAG,
} from '../../shared/contracts/telemetry.ts';
import type {
  AiGenerationProperties, ExceptionFrame, ExceptionProperties, SessionExitKind, TelemetryAdapter,
} from '../../shared/contracts/telemetry.ts';
import type { UsageGenerationRollupRow } from './usage-entry-core.ts';

const POSTHOG_INGEST_HOST = 'https://us.i.posthog.com';
const POSTHOG_PROJECT_TOKEN = 'phc_s68t9vWmeGcrWkx4NkLQaEiVZ9sMBxv8GjQBbAcix2Sf';
const TELEMETRY_BATCH_URL = `${POSTHOG_INGEST_HOST}/batch/`;
const TELEMETRY_FLAGS_URL = `${POSTHOG_INGEST_HOST}/flags?v=2`;

const MAX_STACK_LENGTH = 16384;

const FIRST_RUN_NOTICE = [
  'Glimmervoid sends anonymous usage and error data to help improve it: app starts, daily activity, session starts and ends with the agent kind, exit kind and duration, errors as their type, error code and scrubbed stack frames, and per session token counts, models and estimated cost. No error messages, paths, repository names, prompts, model output or terminal output.',
  'Turn it off in Settings > Privacy, or set GLIMMERVOID_TELEMETRY=0 or DO_NOT_TRACK=1.',
].join('\n');

type TelemetryConsentSource = 'do-not-track' | 'environment' | 'ci' | 'config' | 'default';

interface TelemetryConsent {
  isEnabled: boolean;
  source: TelemetryConsentSource;
}

interface TelemetryEnvironment {
  DO_NOT_TRACK?: string;
  GLIMMERVOID_TELEMETRY?: string;
  GLIMMERVOID_TELEMETRY_PROJECT_TOKEN?: string;
  CI?: string;
}

interface TelemetryConfig {
  telemetry?: { enabled?: boolean } | null;
}

interface ExitDetail {
  exitCode: number | null;
  signal: unknown;
  reason?: string | null;
}

const TRUTHY_FLAGS = new Set(['1', 'true', 'yes']);
const FALSY_FLAGS = new Set(['0', 'false', 'no', 'off']);

function normalizedFlag(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function decideTelemetryConsent(env: TelemetryEnvironment, config: TelemetryConfig): TelemetryConsent {
  if (TRUTHY_FLAGS.has(normalizedFlag(env.DO_NOT_TRACK))) return { isEnabled: false, source: 'do-not-track' };
  if (FALSY_FLAGS.has(normalizedFlag(env.GLIMMERVOID_TELEMETRY))) return { isEnabled: false, source: 'environment' };
  if (TRUTHY_FLAGS.has(normalizedFlag(env.CI))) return { isEnabled: false, source: 'ci' };
  const configured = config.telemetry?.enabled;
  if (typeof configured === 'boolean') return { isEnabled: configured, source: 'config' };
  return { isEnabled: true, source: 'default' };
}

function isTelemetryForcedOff(env: TelemetryEnvironment): boolean {
  return decideTelemetryConsent(env, { telemetry: { enabled: true } }).isEnabled === false;
}

function resolveProjectToken(env: TelemetryEnvironment): string {
  const override = env.GLIMMERVOID_TELEMETRY_PROJECT_TOKEN?.trim();
  return override || POSTHOG_PROJECT_TOKEN;
}

function toForwardSlashes(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function isWindowsStylePath(filePath: string): boolean {
  return /^[A-Za-z]:\//.test(filePath);
}

function comparablePath(filePath: string): string {
  const forward = toForwardSlashes(filePath).replace(/\/+$/, '');
  return isWindowsStylePath(forward) ? forward.toLowerCase() : forward;
}

function decodedFileUrlPath(fileUrl: string): string {
  const urlPath = fileUrl.slice('file://'.length).replace(/^\/([A-Za-z]:)/, '$1');
  try {
    return decodeURIComponent(urlPath);
  } catch {
    return urlPath;
  }
}

function stripFileScheme(rawPath: string): string {
  if (!rawPath.startsWith('file://')) return toForwardSlashes(rawPath);
  return toForwardSlashes(decodedFileUrlPath(rawPath));
}

function relativeUnder(filePath: string, root: string): string | null {
  if (!root) return null;
  const comparableRoot = comparablePath(root);
  if (!comparableRoot) return null;
  const comparableFile = comparablePath(filePath);
  if (!comparableFile.startsWith(`${comparableRoot}/`)) return null;
  return toForwardSlashes(filePath).slice(comparableRoot.length + 1);
}

function scrubLocalPath(rawPath: string, packageRoot: string): string {
  const filePath = stripFileScheme(rawPath);
  if (filePath.startsWith('node:')) return filePath;
  const underPackage = relativeUnder(filePath, packageRoot);
  if (underPackage !== null) return underPackage;
  const nodeModulesAt = filePath.lastIndexOf('/node_modules/');
  if (nodeModulesAt >= 0) return filePath.slice(nodeModulesAt + 1);
  return filePath.slice(filePath.lastIndexOf('/') + 1);
}

function isInApp(rawPath: string, packageRoot: string): boolean {
  const filePath = stripFileScheme(rawPath);
  if (filePath.startsWith('node:')) return false;
  const underPackage = relativeUnder(filePath, packageRoot);
  if (underPackage === null) return false;
  return !underPackage.split('/').includes('node_modules');
}

const V8_FRAME_WITH_FUNCTION = /^\s*at (.+?) \((.+?):(\d+):(\d+)\)$/;
const V8_FRAME_ANONYMOUS = /^\s*at (.+?):(\d+):(\d+)$/;

interface RawFrame {
  functionName: string;
  filePath: string;
  line: string;
  column: string;
}

function matchV8Frame(stackLine: string): RawFrame | null {
  const named = V8_FRAME_WITH_FUNCTION.exec(stackLine);
  if (named) return { functionName: named[1].replace(/^async /, ''), filePath: named[2], line: named[3], column: named[4] };
  const anonymous = V8_FRAME_ANONYMOUS.exec(stackLine);
  if (!anonymous) return null;
  return { functionName: '?', filePath: anonymous[1].replace(/^async /, ''), line: anonymous[2], column: anonymous[3] };
}

function parseV8StackFrames(stack: string, packageRoot: string, platform: ExceptionFrame['platform'] = 'node:javascript'): ExceptionFrame[] {
  const frames: ExceptionFrame[] = [];
  for (const stackLine of stack.slice(0, MAX_STACK_LENGTH).split('\n')) {
    const rawFrame = matchV8Frame(stackLine);
    if (!rawFrame) continue;
    frames.push({
      platform,
      function: rawFrame.functionName.slice(0, MAX_TEXT_LENGTH),
      filename: scrubLocalPath(rawFrame.filePath, packageRoot).slice(0, MAX_TEXT_LENGTH),
      lineno: Number(rawFrame.line),
      colno: Number(rawFrame.column),
      in_app: isInApp(rawFrame.filePath, packageRoot),
    });
    if (frames.length >= MAX_EXCEPTION_FRAMES) break;
  }
  return frames.reverse();
}

const ERROR_CODE_SHAPE = /^[A-Z][A-Z0-9_]{0,63}$/;

function safeErrorCode(error: Error): string {
  const code: unknown = Reflect.get(error, 'code');
  if (typeof code !== 'string') return '';
  return ERROR_CODE_SHAPE.test(code) ? code : '';
}

function errorParts(error: unknown): { type: string; code: string; stack: string } {
  if (error instanceof Error) return { type: error.name || 'Error', code: safeErrorCode(error), stack: error.stack ?? '' };
  return { type: 'NonError', code: '', stack: '' };
}

function exceptionPropertiesOf(
  { type, code, handled, level, frames }:
  { type: string; code: string; handled: boolean; level: ExceptionProperties['$exception_level']; frames: ExceptionFrame[] },
): ExceptionProperties {
  return {
    $exception_list: [{
      type: type.slice(0, MAX_TEXT_LENGTH),
      value: code,
      mechanism: { handled, synthetic: false, type: 'generic' },
      stacktrace: { type: 'raw', frames },
    }],
    $exception_level: level,
  };
}

function buildExceptionProperties(
  error: unknown,
  { handled, packageRoot }: { handled: boolean; packageRoot: string },
): ExceptionProperties {
  const parts = errorParts(error);
  return exceptionPropertiesOf({
    type: parts.type,
    code: parts.code,
    handled,
    level: handled ? 'error' : 'fatal',
    frames: parseV8StackFrames(parts.stack, packageRoot),
  });
}

const BROWSER_FRAME_GECKO = /^\s*([^@]*)@(.+?):(\d+):(\d+)$/;
const URL_ORIGIN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/;
const SAFE_ERROR_TYPE_NAME = /^[A-Za-z_$][\w$]{0,127}$/;

function isWebUrl(rawUrl: string): boolean {
  return /^https?:\/\//i.test(rawUrl);
}

function lastPathSegment(urlPath: string): string {
  return urlPath.slice(urlPath.lastIndexOf('/') + 1);
}

function scrubWebPath(webPath: string): string {
  const nodeModulesAt = webPath.lastIndexOf('/node_modules/');
  if (nodeModulesAt >= 0) return webPath.slice(nodeModulesAt + 1);
  if (webPath.startsWith('/@fs/')) return lastPathSegment(webPath);
  return webPath;
}

function urlPathOnly(rawUrl: string): string {
  const [withoutQueryOrHash] = rawUrl.split(/[?#]/, 1);
  if (isWebUrl(withoutQueryOrHash)) return scrubWebPath(withoutQueryOrHash.replace(URL_ORIGIN, '') || '/');
  return lastPathSegment(withoutQueryOrHash);
}

function matchBrowserFrame(stackLine: string): RawFrame | null {
  const v8Frame = matchV8Frame(stackLine);
  if (v8Frame) return v8Frame;
  const gecko = BROWSER_FRAME_GECKO.exec(stackLine);
  if (!gecko) return null;
  return { functionName: gecko[1] || '?', filePath: gecko[2], line: gecko[3], column: gecko[4] };
}

function parseBrowserStackFrames(stack: string): ExceptionFrame[] {
  const frames: ExceptionFrame[] = [];
  for (const stackLine of stack.slice(0, MAX_STACK_LENGTH).split('\n')) {
    const rawFrame = matchBrowserFrame(stackLine);
    if (!rawFrame) continue;
    frames.push({
      platform: 'web:javascript',
      function: rawFrame.functionName.slice(0, MAX_TEXT_LENGTH),
      filename: urlPathOnly(rawFrame.filePath).slice(0, MAX_TEXT_LENGTH),
      lineno: Number(rawFrame.line),
      colno: Number(rawFrame.column),
      in_app: isWebUrl(rawFrame.filePath),
    });
    if (frames.length >= MAX_EXCEPTION_FRAMES) break;
  }
  return frames.reverse();
}

function safeErrorTypeName(name: string): string {
  return SAFE_ERROR_TYPE_NAME.test(name) ? name : 'Error';
}

function buildBrowserExceptionProperties({ name, stack }: ClientErrorReport): ExceptionProperties {
  return exceptionPropertiesOf({
    type: safeErrorTypeName(name),
    code: '',
    handled: false,
    level: 'error',
    frames: parseBrowserStackFrames(stack),
  });
}

function exceptionFingerprint(properties: ExceptionProperties): string {
  const [exception] = properties.$exception_list;
  const inAppFrames = exception.stacktrace.frames
    .filter((frame) => frame.in_app)
    .map((frame) => `${frame.function}@${frame.filename}`);
  return [exception.type, ...inAppFrames].join('|');
}

function isBuiltinAgentId(agentId: string | null | undefined): agentId is (typeof BUILTIN_AGENT_IDS)[number] {
  return BUILTIN_AGENT_IDS.some((builtinAgentId) => builtinAgentId === agentId);
}

function adapterBucket(agentId: string | null | undefined): TelemetryAdapter {
  if (isBuiltinAgentId(agentId)) return agentId;
  return 'custom';
}

function classifySessionExit({ exitCode, signal, reason }: ExitDetail): SessionExitKind {
  if (reason === 'no_output_before_exit') return 'no_output';
  if (signal) return 'signal';
  if (exitCode === 0) return 'clean';
  return 'error';
}

const AI_PROVIDER_BY_VENDOR: Readonly<Record<string, string>> = Object.freeze({
  claude: 'anthropic',
  codex: 'openai',
  grok: 'xai',
});

const AGENT_ID_BY_VENDOR: Readonly<Record<string, string>> = Object.freeze({
  claude: 'claude-code',
  codex: 'codex',
  grok: 'grok',
});

function aiTraceId(installId: string, sessionId: string): string {
  return createHash('sha256').update(`${installId}${sessionId}`).digest('hex');
}

function wholeTokenCount(tokens: number): number {
  return Math.max(0, Math.round(tokens));
}

function buildAiGenerationEvent(row: UsageGenerationRollupRow, installId: string): AiGenerationProperties {
  const properties: AiGenerationProperties = {
    $ai_trace_id: aiTraceId(installId, row.sessionId),
    $ai_provider: (AI_PROVIDER_BY_VENDOR[row.vendor] ?? row.vendor).slice(0, MAX_AI_PROVIDER_LENGTH),
    $ai_model: row.isModelKnown ? row.model.slice(0, MAX_AI_MODEL_LENGTH) : 'unknown',
    $ai_input_tokens: wholeTokenCount(row.input),
    $ai_output_tokens: wholeTokenCount(row.output),
    $ai_cache_read_input_tokens: wholeTokenCount(row.cacheRead),
    $ai_cache_creation_input_tokens: wholeTokenCount(row.cacheCreate),
    agent_adapter: adapterBucket(AGENT_ID_BY_VENDOR[row.vendor]),
  };
  if (!row.hasKnownCost) return properties;
  return { ...properties, $ai_total_cost_usd: Math.max(0, row.costUSD) };
}

function hasAnyTokens(row: UsageGenerationRollupRow): boolean {
  return row.input + row.output + row.cacheRead + row.cacheCreate > 0;
}

function buildAiGenerationEvents(rows: readonly UsageGenerationRollupRow[], installId: string): AiGenerationProperties[] {
  return rows.filter(hasAnyTokens).map((row) => buildAiGenerationEvent(row, installId));
}

type RemoteTelemetryState = 'enabled' | 'disabled';

function decideRemoteTelemetryState(previous: RemoteTelemetryState, response: unknown): RemoteTelemetryState {
  const parsed = FeatureFlagsResponse.safeParse(response);
  if (!parsed.success || parsed.data.errorsWhileComputingFlags === true) return previous;
  const killSwitchFlag = parsed.data.flags[TELEMETRY_KILL_SWITCH_FLAG];
  if (!killSwitchFlag) return previous;
  return killSwitchFlag.enabled ? 'enabled' : 'disabled';
}

const POSTHOG_RELEASE_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function parsePosthogReleaseId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return POSTHOG_RELEASE_ID_SHAPE.test(value) ? value : null;
}

function decideIsDevInstall(
  { installFlavor, isBundled, homeDir, defaultHomeDir }: { installFlavor: string; isBundled: boolean; homeDir: string; defaultHomeDir: string },
): boolean {
  if (installFlavor === 'clone' || !isBundled) return true;
  return comparablePath(homeDir) !== comparablePath(defaultHomeDir);
}

function nodeMajorVersion(nodeVersion: string): number {
  const major = Number.parseInt(nodeVersion.replace(/^v/, ''), 10);
  return Number.isFinite(major) ? major : 0;
}

export {
  FIRST_RUN_NOTICE, POSTHOG_PROJECT_TOKEN, TELEMETRY_BATCH_URL, TELEMETRY_FLAGS_URL,
  adapterBucket, buildAiGenerationEvents, buildBrowserExceptionProperties, buildExceptionProperties, classifySessionExit,
  decideIsDevInstall, decideRemoteTelemetryState, decideTelemetryConsent, exceptionFingerprint, isTelemetryForcedOff, nodeMajorVersion,
  parseBrowserStackFrames, parsePosthogReleaseId, parseV8StackFrames, resolveProjectToken, scrubLocalPath, urlPathOnly,
};
export type { RemoteTelemetryState, TelemetryConfig, TelemetryConsent, TelemetryEnvironment };
