import path from 'node:path';
import { z } from 'zod';
import { isRecord } from '../../shared/coerce.ts';
import { PACK_DIR_PLACEHOLDER, PACK_HOOK_AGENTS, PackHooks } from '../../shared/contracts/pack.ts';
import type { PackHook, PackHookAgent, PackHookInput } from '../../shared/contracts/pack.ts';
import { buildHookCommand } from './hook-command-core.ts';
import type { UserHook } from '../../shared/contracts/hooks.ts';

const PACK_HOOK_FILES_ENV = 'GLIMMERVOID_PACK_HOOK_FILES';
const PACK_HOOKS_FILE_NAME = 'hooks.json';
const PACK_COPY_FOLDER_NAME = 'pack';
const PACK_HOOK_USER_HOOK_AGENTS: Readonly<Record<string, PackHookAgent>> = { 'claude-code': 'claude', codex: 'codex' };
const PACK_HOOK_RELAY_TOOL_ID = 'packHooks';
const ANTIGRAVITY_PACK_HOOK_FLAVOR: PackHookAgent = 'antigravity';
const KIMI_PACK_HOOK_FLAVOR: PackHookAgent = 'kimi';
const MAX_DENY_REASON_CHARACTERS = 4000;
const PACK_HOOK_RELAY_TIMEOUT_SECONDS = 600;
const PACK_HOOK_RELAY_BUDGET_MS = (PACK_HOOK_RELAY_TIMEOUT_SECONDS - 30) * 1000;

type PackHookToolKind = PackHook['tools'][number];
type PackHookCallKind = PackHookToolKind | 'other';

const PACK_HOOK_TOOL_KINDS_BY_AGENT: Readonly<Record<PackHookAgent, Readonly<Record<string, PackHookToolKind>>>> = {
  claude: { Bash: 'shell', PowerShell: 'shell', Monitor: 'shell', Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit' },
  codex: { Bash: 'shell', shell: 'shell', local_shell: 'shell', exec_command: 'shell', apply_patch: 'edit' },
  kimi: { Bash: 'shell', Write: 'edit', Edit: 'edit' },
  antigravity: {
    run_command: 'shell', write_file: 'edit', write_to_file: 'edit', edit_file: 'edit', create_file: 'edit', delete_file: 'edit',
    apply_patch: 'edit', replace_file_content: 'edit', multi_replace_file_content: 'edit',
  },
  opencode: { bash: 'shell', edit: 'edit', write: 'edit', patch: 'edit', multiedit: 'edit' },
  pi: { bash: 'shell', edit: 'edit', write: 'edit' },
};
const FILE_PATH_KEYS: readonly string[] = ['file_path', 'filePath', 'path', 'notebook_path', 'TargetFile', 'Path', 'AbsolutePath'];
const SESSION_ID_KEYS: readonly string[] = ['session_id', 'sessionID', 'sessionId', 'conversationId'];
const COMMAND_KEYS: readonly string[] = ['command', 'cmd', 'CommandLine'];
const PATCH_FILE_LINE = /^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/;

type ResolvedPackHook = { pack: string; id: string; tools: readonly PackHookToolKind[]; argv: string[]; timeoutMs: number };

const PackHooksFile = z.strictObject({ pack: z.string().min(1), hooks: PackHooks });

function toolKindOf(agentFlavor: PackHookAgent, toolName: string): PackHookCallKind {
  return PACK_HOOK_TOOL_KINDS_BY_AGENT[agentFlavor][toolName] ?? 'other';
}

function packHookToolNamesOf(agentFlavor: PackHookAgent): string[] {
  return Object.keys(PACK_HOOK_TOOL_KINDS_BY_AGENT[agentFlavor]);
}

function packHookAgentOf(flavor: string): PackHookAgent | null {
  return (PACK_HOOK_AGENTS as readonly string[]).includes(flavor) ? flavor as PackHookAgent : null;
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return value.join(' ');
  return null;
}

function firstTextOf(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const text = textOf(record[key]);
    if (text !== null) return text;
  }
  return null;
}

function patchFilePaths(patchText: string | null): string[] {
  if (patchText === null) return [];
  return patchText.split(/\r?\n/).flatMap((line) => {
    const match = PATCH_FILE_LINE.exec(line);
    return match?.[1] ? [match[1].trim()] : [];
  });
}

function filePathsOf(kind: PackHookCallKind, toolInput: Record<string, unknown>, command: string | null): string[] {
  if (kind !== 'edit') return [];
  const directPaths = FILE_PATH_KEYS.flatMap((key) => (typeof toolInput[key] === 'string' ? [toolInput[key]] : []));
  const patchText = typeof toolInput.patch === 'string' ? toolInput.patch : command;
  return [...new Set([...directPaths, ...patchFilePaths(patchText)])];
}

function toolCallOf(payload: Record<string, unknown>): { name: string; input: unknown } | null {
  if (typeof payload.tool_name === 'string') return { name: payload.tool_name, input: payload.tool_input };
  const toolCall = payload.toolCall;
  if (isRecord(toolCall) && typeof toolCall.name === 'string') return { name: toolCall.name, input: toolCall.args };
  return null;
}

function packHookInputOf(flavorText: string, payload: unknown, fallbackCwd: string): PackHookInput | null {
  const flavor = packHookAgentOf(flavorText);
  if (flavor === null || !isRecord(payload)) return null;
  const toolCall = toolCallOf(payload);
  if (toolCall === null) return null;
  const toolInput = isRecord(toolCall.input) ? toolCall.input : {};
  const kind = toolKindOf(flavor, toolCall.name);
  const command = firstTextOf(toolInput, COMMAND_KEYS);
  const cwd = typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : fallbackCwd;
  return {
    version: 1, event: 'beforeTool', agent: flavor, sessionId: firstTextOf(payload, SESSION_ID_KEYS), cwd,
    tool: { kind, name: toolCall.name, command: kind === 'shell' ? command : null, filePaths: filePathsOf(kind, toolInput, command), input: toolCall.input ?? null },
  };
}

function hooksForCall(hooks: readonly ResolvedPackHook[], kind: PackHookCallKind): ResolvedPackHook[] {
  if (kind === 'other') return [];
  return hooks.filter((hook) => hook.tools.includes(kind));
}

function packHooksFileText(packName: string, hooks: readonly PackHook[]): string {
  return `${JSON.stringify({ pack: packName, hooks }, null, 2)}\n`;
}

function resolvedPackHooksOf(fileText: string, hooksFilePath: string): ResolvedPackHook[] {
  const parsed = (() => {
    try { return PackHooksFile.safeParse(JSON.parse(fileText)); } catch { return null; }
  })();
  if (!parsed?.success) return [];
  const packDir = path.join(path.dirname(hooksFilePath), PACK_COPY_FOLDER_NAME);
  return parsed.data.hooks.map((hook) => ({ pack: parsed.data.pack, id: hook.id, tools: hook.tools, argv: packHookArgv(hook.command, packDir), timeoutMs: hook.timeoutSeconds * 1000 }));
}

function packHookFilesEnv(hookFiles: readonly string[]): Record<string, string> {
  if (hookFiles.length === 0) return {};
  return { [PACK_HOOK_FILES_ENV]: hookFiles.join(path.delimiter) };
}

function packHookFilesOf(envValue: string | undefined): string[] {
  return (envValue ?? '').split(path.delimiter).map((filePath) => filePath.trim()).filter((filePath) => filePath !== '');
}

function packHookUserHooks(agentId: string, hookToolRelayLaunch: readonly string[], hookFiles: readonly string[]): UserHook[] {
  const agentFlavor = PACK_HOOK_USER_HOOK_AGENTS[agentId];
  if (agentFlavor === undefined || hookFiles.length === 0) return [];
  const command = buildHookCommand(hookToolRelayLaunch, PACK_HOOK_RELAY_TOOL_ID, [agentFlavor]);
  if (command === null) return [];
  const matcher = agentId === 'claude-code' ? { matcher: packHookToolNamesOf(agentFlavor).join('|') } : {};
  return [{ id: 'glimmervoid-pack-hooks', name: 'Pack hooks', event: 'PreToolUse', ...matcher, type: 'command', command, timeout: PACK_HOOK_RELAY_TIMEOUT_SECONDS, enabled: true }];
}

function packHookDenyReason(hook: Pick<ResolvedPackHook, 'pack' | 'id'>, stderrText: string): string {
  const reason = stderrText.trim() || 'the hook refused this call';
  return `[${hook.pack}/${hook.id}] ${reason}`.slice(0, MAX_DENY_REASON_CHARACTERS);
}

function packHookDenyOutput(flavor: string, reason: string): string {
  if (flavor === ANTIGRAVITY_PACK_HOOK_FLAVOR) return JSON.stringify({ decision: 'deny', reason });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

function packHookArgv(command: readonly string[], packDir: string): string[] {
  return command.map((word) => word.split(PACK_DIR_PLACEHOLDER).join(packDir));
}

export type { ResolvedPackHook };
export { ANTIGRAVITY_PACK_HOOK_FLAVOR, KIMI_PACK_HOOK_FLAVOR, PACK_COPY_FOLDER_NAME, PACK_HOOK_RELAY_BUDGET_MS, PACK_HOOK_RELAY_TIMEOUT_SECONDS, PACK_HOOKS_FILE_NAME, PACK_HOOK_FILES_ENV, PACK_HOOK_RELAY_TOOL_ID, hooksForCall, packHookDenyOutput, packHookToolNamesOf, packHookDenyReason, packHookFilesEnv, packHookFilesOf, packHookInputOf, packHookUserHooks, packHooksFileText, resolvedPackHooksOf };
