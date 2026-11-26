import path from 'node:path';
import { z } from 'zod';
import { AttentionOwner, DONE_MEANS_MAX_LINES, ParentLink, TaskTitle } from './session.ts';
import { legacyParentLinkOf } from '../parent-link.ts';
import { SessionPrLinks } from './my-prs.ts';
import { BranchGcControlSettings, GithubSettings,
  createBrowserConfig, optionalBoolean, optionalLooseObject, WorktreeControlSettings,
  TelemetryFileSettings, VaultFileSettings,
} from './browser-config.ts';
import { WorkflowsSettingsUpdate } from './workflows.ts';
import { isLinkUrlSafe } from './watcher-link.ts';
import { AgentHomeKind, AgentSetup } from './agent-models.ts';
import { AgentAccountDefaults, AgentAccountId, AgentAccounts, LaneAccounts } from './agent-accounts.ts';
import { GitObjectSha, RaceId } from './race.ts';
import type { BranchGcFileSettings as BranchGcFileSettingsSchema, WorktreeFileSettings } from './browser-config.ts';

export {
  BranchGcFileSettings,
} from './browser-config.ts';

export const BrowserConfig = createBrowserConfig(path.isAbsolute);
const BROWSER_CONFIG_SHAPE = BrowserConfig.shape;
export const ConfigUpdate = z.object({
  ...BROWSER_CONFIG_SHAPE,
  branchGc: BranchGcControlSettings,
  worktree: WorktreeControlSettings,
  shareCommitProvenance: optionalBoolean('shareCommitProvenance'),
  workflows: WorkflowsSettingsUpdate.optional(),
}).omit({ port: true }).strict();
const AGENT_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const SHELL_AGENT_ID = 'shell';
export const BUILTIN_AGENT_IDS = Object.freeze(['claude-code', 'codex', 'gemini', 'grok', 'kimi', 'qwen', 'copilot', 'opencode', 'pi', 'antigravity', 'goose', 'cursor', SHELL_AGENT_ID] as const);
export const BUILTIN_ACP_AGENT_IDS = Object.freeze(['claude-code', 'codex'] as const);
const BUILTIN_ACP_AGENT_ID_SET = new Set<string>(BUILTIN_ACP_AGENT_IDS);
export const AGENT_ID_SHAPE_MESSAGE = 'an agent id of 2 to 32 characters of lowercase letters, digits and dashes, starting with a letter';

const AGENT_COMMAND_BASENAME_RE = /^[A-Za-z0-9._+-]+$/;
const AGENT_COMMAND_ABSOLUTE_RE = /^(?:\/|[A-Za-z]:[\\/])[A-Za-z0-9._+\-\\/]*[A-Za-z0-9._+-]$/;
const AGENT_COMMAND_SHAPE_MESSAGE = 'a bare command name or an absolute path, built only from letters, digits, dot, underscore, plus, dash and path separators';

function isSpawnableCommand(command: string): boolean {
  if (command === '.' || command === '..' || command.startsWith('-')) return false;
  if (AGENT_COMMAND_BASENAME_RE.test(command)) return true;
  return AGENT_COMMAND_ABSOLUTE_RE.test(command);
}

const GIT_BRANCH_FORBIDDEN_PUNCTUATION_RE = /[~^:?*[\\]/;
const GIT_BRANCH_FORBIDDEN_SEQUENCES = ['..', '@{', '//'];

function isControlOrSpaceCharacter(character: string): boolean {
  const codePoint = character.charCodeAt(0);
  return codePoint <= 0x20 || codePoint === 0x7f;
}

function isGitBranchName(name: string): boolean {
  if (name === '' || name === '@' || name === 'HEAD') return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  if (GIT_BRANCH_FORBIDDEN_SEQUENCES.some((sequence) => name.includes(sequence))) return false;
  if (GIT_BRANCH_FORBIDDEN_PUNCTUATION_RE.test(name) || [...name].some(isControlOrSpaceCharacter)) return false;
  return name.split('/').every((component) => !component.startsWith('.') && !component.endsWith('.lock'));
}

export const CustomAgentDeclaration = z.object({
  id: z.string({ error: 'customAgents[].id must be a string' }).regex(AGENT_ID_RE, { error: `customAgents[].id must be ${AGENT_ID_SHAPE_MESSAGE}` }),
  label: z.string({ error: 'customAgents[].label must be a string' })
    .min(1, { error: 'customAgents[].label must not be empty' })
    .max(60, { error: 'customAgents[].label must be at most 60 characters' }),
  command: z.string({ error: 'customAgents[].command must be a string' })
    .min(1, { error: 'customAgents[].command must not be empty' })
    .refine((command) => command.trim().length > 0, { error: 'customAgents[].command must not be blank' })
    .refine(isSpawnableCommand, { error: `customAgents[].command must be ${AGENT_COMMAND_SHAPE_MESSAGE}` }),
  args: z.array(z.string({ error: 'customAgents[].args must be an array of strings' }), { error: 'customAgents[].args must be an array of strings' }).default([]),
  idleTitle: z.string({ error: 'customAgents[].idleTitle must be a string' }).optional(),
  busyTitle: z.string({ error: 'customAgents[].busyTitle must be a string' }).optional(),
  homeEnvName: z.string({ error: 'customAgents[].homeEnvName must be a string' })
    .regex(/^[A-Z_][A-Z0-9_]*$/, { error: 'customAgents[].homeEnvName must be an environment variable name in capital letters, digits and underscores' })
    .optional(),
}).strict();

const CustomAgentDeclarations = z.array(CustomAgentDeclaration, { error: 'customAgents must be an array' })
  .superRefine((declarations, ctx) => {
    const claimedIds = new Set<string>();
    for (const [index, declaration] of declarations.entries()) {
      if (!claimedIds.has(declaration.id)) {
        claimedIds.add(declaration.id);
        continue;
      }
      ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `customAgents[${index}].id "${declaration.id}" is declared more than once` });
    }
  });

export const AcpAgentDeclaration = z.object({
  id: z.string({ error: 'acpAgents[].id must be a string' }).regex(AGENT_ID_RE, { error: `acpAgents[].id must be ${AGENT_ID_SHAPE_MESSAGE}` }),
  label: z.string({ error: 'acpAgents[].label must be a string' })
    .min(1, { error: 'acpAgents[].label must not be empty' })
    .max(60, { error: 'acpAgents[].label must be at most 60 characters' }),
  command: z.string({ error: 'acpAgents[].command must be a string' })
    .min(1, { error: 'acpAgents[].command must not be empty' })
    .refine((command) => command.trim().length > 0, { error: 'acpAgents[].command must not be blank' })
    .refine(isSpawnableCommand, { error: `acpAgents[].command must be ${AGENT_COMMAND_SHAPE_MESSAGE}` }),
  args: z.array(
    z.string({ error: 'acpAgents[].args must be an array of strings' })
      .refine((argument) => !argument.includes('\0'), { error: 'acpAgents[].args must not contain null bytes' }),
    { error: 'acpAgents[].args must be an array of strings' },
  ).default([]),
}).strict();

export const AcpAgentDeclarations = z.array(AcpAgentDeclaration, { error: 'acpAgents must be an array' })
  .superRefine((declarations, ctx) => {
    const claimedIds = new Set<string>();
    for (const [index, declaration] of declarations.entries()) {
      if (BUILTIN_ACP_AGENT_ID_SET.has(declaration.id)) {
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `acpAgents[${index}].id "${declaration.id}" collides with a built-in ACP agent; pick a different id` });
        continue;
      }
      if (!claimedIds.has(declaration.id)) {
        claimedIds.add(declaration.id);
        continue;
      }
      ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `acpAgents[${index}].id "${declaration.id}" is declared more than once` });
    }
  });

export const TaskTitleSources = z.object({
  customTitle: TaskTitle.nullable().optional(),
  pendingPromptTitle: TaskTitle.nullable().optional(),
  refinedTitle: TaskTitle.nullable().optional(),
  aiTitle: TaskTitle.nullable().optional(),
  oscTitle: TaskTitle.nullable().optional(),
  promptTitle: TaskTitle.nullable().optional(),
}).strict();

export const TASK_TITLE_SOURCE_PRIORITY = ['customTitle', 'pendingPromptTitle', 'refinedTitle', 'aiTitle', 'oscTitle', 'promptTitle'] as const;

export const PersistedTaskTitle = z.object({
  taskTitle: TaskTitle.min(1),
  isCustom: z.boolean(),
  sources: TaskTitleSources,
}).strict().refine(({ taskTitle, isCustom, sources }) => {
  const source = TASK_TITLE_SOURCE_PRIORITY.find((candidate) => sources[candidate]?.trim());
  if (!source) return false;
  return sources[source]?.replace(/\s+/g, ' ').trim() === taskTitle && isCustom === (source === 'customTitle');
});

const PersistedAgentDoneLine = z.object({ text: z.string().min(1), command: z.string().min(1) });

function readablePersistedDoneLines(lines: unknown[]): z.infer<typeof PersistedAgentDoneLine>[] {
  return lines.flatMap((line) => {
    const parsed = PersistedAgentDoneLine.safeParse(line);
    return parsed.success ? [parsed.data] : [];
  }).slice(0, DONE_MEANS_MAX_LINES);
}

export const ProjectConfig = z.preprocess(legacyParentLinkOf, z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  customTitle: TaskTitle.optional(),
  taskTitleState: PersistedTaskTitle.optional().catch(undefined),
  prLinks: SessionPrLinks.optional().catch(undefined),
  path: z.string(),
  repos: z.array(z.string()).min(2).optional(),
  baseBranch: z.string().refine(isGitBranchName, { error: 'projects[].baseBranch must be a git branch name' }).optional(),
  agent: z.string({ error: 'projects[].agent must be a string' }).regex(AGENT_ID_RE, { error: `projects[].agent must be ${AGENT_ID_SHAPE_MESSAGE}` }).optional(),
  codexBypassHookTrust: z.boolean().optional(),
  dangerouslySkipPermissions: z.boolean({ error: 'projects[].dangerouslySkipPermissions must be a boolean' }).optional(),
  saneYolo: z.boolean({ error: 'projects[].saneYolo must be a boolean' }).optional(),
  questionManagerOn: z.boolean({ error: 'projects[].questionManagerOn must be a boolean' }).optional(),
  agentSetup: AgentSetup.optional(),
  agentHome: AgentHomeKind.optional(),
  accountId: AgentAccountId.optional(),
  raceId: RaceId.optional(),
  attentionOwner: AttentionOwner.optional(),
  startSha: GitObjectSha.optional(),
  isStartPinned: z.boolean().optional(),
  parent: ParentLink.optional().catch(undefined),
  isStudioMain: z.boolean().optional().catch(undefined),
  studioRole: z.literal('orchestrator').optional().catch(undefined),
  isDoneMeansOff: z.boolean().optional(),
  agentDoneLines: z.array(z.unknown()).transform(readablePersistedDoneLines).optional().catch(undefined),
}).passthrough());
const FILE_CONFIG_SHAPE = {
  ...BROWSER_CONFIG_SHAPE,
  branchGc: optionalLooseObject('branchGc'),
  github: GithubSettings,
  teamReview: optionalLooseObject('teamReview'),
  community: optionalLooseObject('community'),
  questionManager: optionalLooseObject('questionManager'),
  posthog: optionalLooseObject('posthog'),
  usage: optionalLooseObject('usage'),
  telegram: optionalLooseObject('telegram'),
  slack: optionalLooseObject('slack'),
  sessionReview: optionalLooseObject('sessionReview'),
  planGate: optionalLooseObject('planGate'),
  sessionChat: optionalLooseObject('sessionChat'),
  agentRules: optionalLooseObject('agentRules'),
  reactions: optionalLooseObject('reactions'),
  workflows: optionalLooseObject('workflows'),
  prFlows: optionalLooseObject('prFlows'),
  packs: z.array(z.string({ error: 'packs must list pack directory paths' }).min(1, { error: 'packs must list pack directory paths' }), { error: 'packs must be an array of pack directory paths' }).optional(),
  guardrails: optionalLooseObject('guardrails'),
  verification: optionalLooseObject('verification'),
  sessionSandbox: optionalBoolean('sessionSandbox'),
  telemetry: TelemetryFileSettings,
  customAgents: CustomAgentDeclarations.optional(),
  acpAgents: AcpAgentDeclarations.optional(),
  agentAccounts: AgentAccounts.optional(),
  agentAccountDefaults: AgentAccountDefaults.optional(),
  laneAccounts: LaneAccounts.optional(),
};
export const Config = z.object({
  ...FILE_CONFIG_SHAPE,
  shareCommitProvenance: optionalBoolean('shareCommitProvenance'),
  hooks: z.unknown().optional(),
  remote: z.object({
    port: z.number().int().min(1).max(65535).nullable().optional(),
    publicHost: z.string().optional(),
    allowedOrigins: z.array(z.string()).optional(),
    ownerLogin: z.string().optional(),
    doormanUrl: z.string().refine(isLinkUrlSafe, { error: 'remote.doormanUrl must use https, or http only for this machine' }).optional(),
  }).passthrough().optional(),
  vault: VaultFileSettings,
  projects: z.array(ProjectConfig),
}).passthrough().superRefine((config, ctx) => {
  if (!Array.isArray(config.projects)) return;
  const declaredAgentIds = new Set<string>(BUILTIN_AGENT_IDS);
  for (const declaration of config.customAgents ?? []) declaredAgentIds.add(declaration.id);
  for (const [index, project] of config.projects.entries()) {
    const agent = project?.agent;
    if (typeof agent !== 'string' || !AGENT_ID_RE.test(agent)) continue;
    if (declaredAgentIds.has(agent)) continue;
    ctx.addIssue({
      code: 'custom',
      path: ['projects', index, 'agent'],
      message: `projects[${index}].agent "${agent}" names no known agent; declare it under customAgents or use one of ${[...declaredAgentIds].join(', ')}`,
    });
  }
  for (const [index, account] of (config.agentAccounts ?? []).entries()) {
    if (declaredAgentIds.has(account.agent)) continue;
    ctx.addIssue({ code: 'custom', path: ['agentAccounts', index, 'agent'], message: `agentAccounts[${index}].agent "${account.agent}" names no known agent` });
  }
});

export const CONFIG_BLOCK_KEYS = Object.freeze([
  'taskTitle', 'branchGc', 'github', 'lanes', 'teamReview', 'community', 'questionManager', 'posthog', 'usage', 'telegram',
  'telemetry', 'vault', 'workflows', 'worktree', 'loopGuard', 'slack', 'sessionReview', 'planGate', 'sessionChat', 'agentRules', 'reactions',
]);
export const CONFIG_SCALAR_KEYS = Object.freeze(Object.keys(BROWSER_CONFIG_SHAPE).filter((key) => {
  if (CONFIG_BLOCK_KEYS.includes(key)) return false;
  return key !== 'port' && key !== 'repoRoots';
}));
export const RUNTIME_CONFIG_SCALAR_KEYS = Object.freeze([
  ...CONFIG_SCALAR_KEYS,
  'shareCommitProvenance',
]);
export const HIDDEN_CONFIG_KEYS = Object.freeze([
  'shareCommitProvenance',
  'hooks',
  'remote',
  'projects',
]);

export function configIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message || 'settings are invalid';
}

export type BranchGcFileSettings = z.infer<typeof BranchGcFileSettingsSchema>;
export type Config = z.infer<typeof Config>;
export type BrowserConfig = z.infer<typeof BrowserConfig>;
export type ConfigUpdate = z.infer<typeof ConfigUpdate>;
export type WorktreeSettings = z.infer<typeof WorktreeFileSettings>;
export type ProjectConfig = z.infer<typeof ProjectConfig>;
export type CustomAgentDeclaration = z.infer<typeof CustomAgentDeclaration>;
export type AcpAgentDeclaration = z.infer<typeof AcpAgentDeclaration>;
export type TaskTitleSources = z.infer<typeof TaskTitleSources>;
export type PersistedTaskTitle = z.infer<typeof PersistedTaskTitle>;
