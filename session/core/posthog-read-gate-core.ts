import { isRecord } from '../../shared/coerce.ts';

const LOOKUP_VERBS: ReadonlySet<string> = new Set(['help', 'tools', 'search', 'info', 'schema', 'learn']);
const READ_TOOL_PATTERNS: readonly RegExp[] = Object.freeze([
  /-list$/, /-get$/, /-get-all$/, /-retrieve$/, /^query-/, /^execute-sql$/, /^read-data-schema$/, /^docs-search$/,
]);
const ALLOWED_CALL_FLAGS: ReadonlySet<string> = new Set(['--json']);
const POSTHOG_READ_GATE_DENIAL_PREFIX = 'Glimmervoid lanes read PostHog only: ';
const KNOWN_WRITE_COMMAND = 'call feature-flag-create {"key":"glimmervoid-gate-self-test"}';

type GateDecision = { allowed: true } | { allowed: false; reason: string };

function deny(reason: string): GateDecision {
  return { allowed: false, reason };
}

function posthogExecToolName(serverName: string): string {
  return `mcp__${serverName}__exec`;
}

function decideCommand(command: unknown): GateDecision {
  if (typeof command !== 'string') return deny('the command is not text');
  if (/[\r\n]/.test(command)) return deny('a command must be one line');
  const [verb = '', ...rest] = command.trim().split(/\s+/);
  if (LOOKUP_VERBS.has(verb)) return { allowed: true };
  if (verb !== 'call') return deny(`${verb || 'an empty command'} is not a read`);
  const disallowedFlag = rest.find((word) => word.startsWith('-') && !ALLOWED_CALL_FLAGS.has(word));
  if (disallowedFlag) return deny(`the flag ${disallowedFlag} is not allowed`);
  const toolName = rest.find((word) => !word.startsWith('-'));
  if (!toolName) return deny('call names no tool');
  if (READ_TOOL_PATTERNS.some((pattern) => pattern.test(toolName))) return { allowed: true };
  return deny(`${toolName} is not a read tool`);
}

function decidePosthogExec(hookInput: unknown, serverName: string): GateDecision {
  if (!isRecord(hookInput)) return deny('the hook input is not an object');
  const toolName = hookInput.tool_name;
  if (toolName !== posthogExecToolName(serverName)) return deny(`${String(toolName)} is not allowed, only exec is`);
  const toolInput = hookInput.tool_input;
  if (!isRecord(toolInput)) return deny('the tool input is not an object');
  return decideCommand(toolInput.command);
}

function knownWriteHookInput(serverName: string): string {
  return JSON.stringify({ tool_name: posthogExecToolName(serverName), tool_input: { command: KNOWN_WRITE_COMMAND } });
}

export { POSTHOG_READ_GATE_DENIAL_PREFIX, decidePosthogExec, knownWriteHookInput, posthogExecToolName };
export type { GateDecision };
