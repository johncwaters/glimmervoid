import { isRecord } from '../../shared/coerce.ts';

const SANE_YOLO_PATH_ENV = 'GLIMMERVOID_SANE_YOLO_PATH';
const KIMI_SANE_YOLO_FLAVOR = 'kimi';
const CODEX_SANE_YOLO_FLAVOR = 'codex';
const GEMINI_SANE_YOLO_FLAVOR = 'gemini';
const QWEN_SANE_YOLO_FLAVOR = 'qwen';
const COPILOT_SANE_YOLO_FLAVOR = 'copilot';
const SANE_YOLO_HOST_FLAGS: Record<string, string> = {
  [KIMI_SANE_YOLO_FLAVOR]: '--kimi-code',
  [CODEX_SANE_YOLO_FLAVOR]: '--codex',
  [GEMINI_SANE_YOLO_FLAVOR]: '--gemini-cli',
  [QWEN_SANE_YOLO_FLAVOR]: '--gemini-cli',
  [COPILOT_SANE_YOLO_FLAVOR]: '--copilot-cli',
};

function saneYoloHostFlag(agentFlavor: string): string {
  return SANE_YOLO_HOST_FLAGS[agentFlavor] ?? '--grok-build';
}

const QWEN_SHELL_TOOL_ALIASES: ReadonlyMap<string, string> = new Map([['monitor', 'run_shell_command']]);
const COPILOT_SHELL_INPUT_TOOLS: ReadonlyMap<string, string> = new Map([['write_bash', 'bash'], ['write_powershell', 'powershell']]);

function parsedJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function geminiShapedQwenPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (payload.hook_event_name !== 'PreToolUse') return null;
  const toolInput = payload.tool_input;
  const hasRunFolder = isRecord(toolInput) && typeof toolInput.directory === 'string' && toolInput.dir_path === undefined;
  const geminiToolInput = hasRunFolder ? { ...toolInput, dir_path: toolInput.directory } : toolInput;
  const toolName = typeof payload.tool_name === 'string' ? (QWEN_SHELL_TOOL_ALIASES.get(payload.tool_name) ?? payload.tool_name) : payload.tool_name;
  return { ...payload, hook_event_name: 'BeforeTool', tool_name: toolName, tool_input: geminiToolInput };
}

function commandShapedCopilotPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  const shellToolName = typeof payload.toolName === 'string' ? COPILOT_SHELL_INPUT_TOOLS.get(payload.toolName) : undefined;
  if (!shellToolName) return null;
  const toolArgs = typeof payload.toolArgs === 'string' ? parsedJsonObject(payload.toolArgs) : payload.toolArgs;
  if (!isRecord(toolArgs) || typeof toolArgs.input !== 'string') return null;
  return { ...payload, toolName: shellToolName, toolArgs: { command: toolArgs.input } };
}

const HOST_PAYLOAD_RESHAPERS: ReadonlyMap<string, (payload: Record<string, unknown>) => Record<string, unknown> | null> = new Map([
  [QWEN_SANE_YOLO_FLAVOR, geminiShapedQwenPayload],
  [COPILOT_SANE_YOLO_FLAVOR, commandShapedCopilotPayload],
]);

function saneYoloHostPayload(agentFlavor: string, body: Buffer): Buffer {
  const reshape = HOST_PAYLOAD_RESHAPERS.get(agentFlavor);
  if (!reshape) return body;
  const payload = parsedJsonObject(body.toString('utf8'));
  const hostPayload = payload ? reshape(payload) : null;
  return hostPayload ? Buffer.from(JSON.stringify(hostPayload), 'utf8') : body;
}

function saneYoloPolicy(guardrailsTempRoot: string, unreadablePaths: readonly string[]) {
  return {
    version: 1,
    destructive_command_protection: {
      enabled: true,
      overrides: {
        'git.branch-force-delete': 'off',
        'git.merge-abort': 'off',
        'git.rebase-abort': 'off',
        'rm.recursive-force-dynamic-target': 'on',
      },
      allow_paths: [guardrailsTempRoot],
    },
    secret_protection: { enabled: true, deny_paths: [...unreadablePaths] },
  };
}

const SANE_YOLO_RULES = { version: 1, rules: ['infra', 'git', 'glimmervoid'], overrides: {}, transparent_wrappers: ['rtk', 'npx'] };
const INFRA_REASON = 'Sane YOLO blocks infrastructure teardown; run this command by hand.';
const TERRAFORM_DESTROY_FLAGS = ['-destroy', '--destroy', '-destroy=true', '--destroy=true'];
const SANE_YOLO_INFRA_RULEBOOK = {
  rulebook_version: 1,
  name: 'infra',
  version: '1.1.0',
  allowed_commands: ['terraform', 'tofu', 'pulumi', 'kubectl'],
  rules: [
    { name: 'terraform-destroy', command: 'terraform', subcommand: 'destroy', block_args: ['destroy'], reason: INFRA_REASON },
    { name: 'terraform-apply-destroy', command: 'terraform', subcommand: 'apply', block_args: TERRAFORM_DESTROY_FLAGS, reason: INFRA_REASON },
    { name: 'tofu-destroy', command: 'tofu', subcommand: 'destroy', block_args: ['destroy'], reason: INFRA_REASON },
    { name: 'tofu-apply-destroy', command: 'tofu', subcommand: 'apply', block_args: TERRAFORM_DESTROY_FLAGS, reason: INFRA_REASON },
    { name: 'pulumi-destroy', command: 'pulumi', subcommand: 'destroy', block_args: ['destroy'], reason: INFRA_REASON },
    { name: 'pulumi-down', command: 'pulumi', subcommand: 'down', block_args: ['down'], reason: INFRA_REASON },
    { name: 'kubectl-delete-namespace', command: 'kubectl', subcommand: 'delete', block_args: ['ns', 'namespace', 'namespaces'], reason: INFRA_REASON },
  ],
};

const STASH_REASON = 'Sane YOLO blocks git stash: every worktree shares one stash stack. Set work aside with a WIP commit, or undo an edit with git show HEAD:<path> > <path>.';
const SANE_YOLO_GIT_RULEBOOK = {
  rulebook_version: 1,
  name: 'git',
  version: '1.0.0',
  allowed_commands: ['git'],
  rules: [{ name: 'stash', command: 'git', block_args: ['stash'], reason: STASH_REASON }],
};

const SETTINGS_FILE_REASON = 'Sane YOLO blocks glimmervoid settings set --file in a session: it writes config keys the single-setting set refuses. Use glimmervoid settings set <path> <value>, or ask the operator to run it.';
const SANE_YOLO_GLIMMERVOID_RULEBOOK = {
  rulebook_version: 1,
  name: 'glimmervoid',
  version: '1.0.0',
  allowed_commands: ['glimmervoid'],
  rules: [{ name: 'settings-set-file', command: 'glimmervoid', subcommand: 'settings', block_args: ['--file'], reason: SETTINGS_FILE_REASON }],
};

function saneYoloFiles(guardrailsTempRoot: string, unreadablePaths: readonly string[]) {
  return {
    'policy.json': saneYoloPolicy(guardrailsTempRoot, unreadablePaths),
    'rules/rule.json': SANE_YOLO_RULES,
    'rules/infra/rulebook.json': SANE_YOLO_INFRA_RULEBOOK,
    'rules/git/rulebook.json': SANE_YOLO_GIT_RULEBOOK,
    'rules/glimmervoid/rulebook.json': SANE_YOLO_GLIMMERVOID_RULEBOOK,
  };
}

function saneYoloEnv(homeDir: string): Record<string, string> {
  return {
    CC_SAFETY_NET_HOME: homeDir,
    CC_SAFETY_NET_PROJECT_TIGHTEN_ONLY: '1',
    CC_SAFETY_NET_AUDIT_HOME: homeDir,
    CC_SAFETY_NET_AUDIT_SCOPE: 'blocked',
  };
}

export { CODEX_SANE_YOLO_FLAVOR, COPILOT_SANE_YOLO_FLAVOR, GEMINI_SANE_YOLO_FLAVOR, KIMI_SANE_YOLO_FLAVOR, QWEN_SANE_YOLO_FLAVOR, SANE_YOLO_PATH_ENV, saneYoloEnv, saneYoloFiles, saneYoloHostFlag, saneYoloHostPayload };
