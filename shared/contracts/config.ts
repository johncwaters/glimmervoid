import path from 'node:path';
import { z } from 'zod';
import { TaskTitle } from './session.ts';
import { SessionPrLinks } from './my-prs.ts';
import { BranchGcControlSettings, GithubSettings,
  createBrowserConfig, optionalBoolean, optionalLooseObject,
  PlanReviewSettings, GuardrailsFileSettings, TelemetryFileSettings, TraceSettings,
} from './browser-config.ts';
import { WorkflowsSettingsUpdate } from './workflows.ts';
import type { BranchGcFileSettings as BranchGcFileSettingsSchema } from './browser-config.ts';

export {
  BRANCH_GC_CONTROL_BOOLEAN_KEYS, BRANCH_GC_CONTROL_NUMERIC_KEYS,
  BranchGcFileSettings,
} from './browser-config.ts';

export const BrowserConfig = createBrowserConfig(path.isAbsolute);
const BROWSER_CONFIG_SHAPE = BrowserConfig.shape;
export const ConfigUpdate = z.object({
  ...BROWSER_CONFIG_SHAPE,
  notifyDebounceMs: z.number({ error: 'notifyDebounceMs must be a positive number' }).finite().positive({ error: 'notifyDebounceMs must be a positive number' }).optional(),
  phoneEscalationMs: z.number({ error: 'phoneEscalationMs must be a positive number' }).finite().positive({ error: 'phoneEscalationMs must be a positive number' }).optional(),
  branchGc: BranchGcControlSettings,
  worktreeAutoRebase: optionalBoolean('worktreeAutoRebase'),
  worktreeSyncOnStart: optionalBoolean('worktreeSyncOnStart'),
  worktreeRerere: optionalBoolean('worktreeRerere'),
  workflows: WorkflowsSettingsUpdate.optional(),
}).omit({ port: true, worktreeShare: true }).strict();
const AGENT_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const BUILTIN_AGENT_IDS = Object.freeze(['claude-code', 'codex', 'grok'] as const);
export const AGENT_ID_SHAPE_MESSAGE = 'an agent id of 2 to 32 characters of lowercase letters, digits and dashes, starting with a letter';

const AGENT_COMMAND_BASENAME_RE = /^[A-Za-z0-9._+-]+$/;
const AGENT_COMMAND_ABSOLUTE_RE = /^(?:\/|[A-Za-z]:[\\/])[A-Za-z0-9._+\-\\/]*[A-Za-z0-9._+-]$/;
const AGENT_COMMAND_SHAPE_MESSAGE = 'a bare command name or an absolute path, built only from letters, digits, dot, underscore, plus, dash and path separators';

function isSpawnableCommand(command: string): boolean {
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

const CODER_WORKSPACE_NAME_RE = /^gv-[0-9a-f]{12}$/;
const CODER_ENVIRONMENT_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const CODER_STOP_AFTER_RE = /^[1-9][0-9]*[hm]$/;

const absolutePosixPath = (field: string) => z.string({ error: `${field} must be a string` })
  .refine((value) => path.posix.isAbsolute(value), { error: `${field} must be an absolute path` });
const positiveInteger = (field: string) => z.number({ error: `${field} must be a number` }).int({ error: `${field} must be a whole number` })
  .positive({ error: `${field} must be positive` });

const PARAMETERS_MESSAGE = 'coder.environments[].parameters must map names to strings';

const CoderEnvironment = z.object({
  name: z.string({ error: 'coder.environments[].name must be a string' })
    .regex(CODER_ENVIRONMENT_NAME_RE, { error: 'coder.environments[].name must be 1 to 32 lowercase letters, digits and dashes, starting with a letter' }),
  template: z.string({ error: 'coder.environments[].template must be a string' }).min(1, { error: 'coder.environments[].template must not be empty' })
    .refine((value) => !value.startsWith('-'), { error: 'coder.environments[].template must not start with a dash' }),
  parameters: z.record(z.string(), z.string({ error: PARAMETERS_MESSAGE }), { error: PARAMETERS_MESSAGE }).optional(),
  nodePath: absolutePosixPath('coder.environments[].nodePath'),
  checkoutRoot: absolutePosixPath('coder.environments[].checkoutRoot'),
  readyUrl: z.url({ protocol: /^https?$/, error: 'coder.environments[].readyUrl must be an http or https URL' }).optional(),
  idleStopMinutes: positiveInteger('coder.environments[].idleStopMinutes').optional(),
  stopAfter: z.string().regex(CODER_STOP_AFTER_RE, { error: 'coder.environments[].stopAfter must be a duration like 4h or 90m' }).optional(),
  maxLive: positiveInteger('coder.environments[].maxLive').optional(),
  deleteAfterStoppedDays: positiveInteger('coder.environments[].deleteAfterStoppedDays').optional(),
  hourlyCostUsd: z.number({ error: 'coder.environments[].hourlyCostUsd must be a number' }).nonnegative({ error: 'coder.environments[].hourlyCostUsd must not be negative' }).optional(),
}).strict();

const CoderSettings = z.object({
  appSlug: z.string().optional(),
  environments: z.array(CoderEnvironment).optional().refine((environments) => {
    const names = (environments ?? []).map((environment) => environment.name);
    return new Set(names).size === names.length;
  }, { error: 'coder.environments[].name must be unique' }),
}).loose().optional();

const PORT_MESSAGE = 'projects[].environment.remotePort must be a port from 1 to 65535';

const ProjectEnvironment = z.object({
  name: z.string().regex(CODER_ENVIRONMENT_NAME_RE, { error: 'projects[].environment.name must name a coder environment' }),
  workspace: z.string().regex(CODER_WORKSPACE_NAME_RE, { error: 'projects[].environment.workspace must be gv- and 12 hex digits' }),
  remotePort: z.number({ error: PORT_MESSAGE }).int({ error: PORT_MESSAGE }).min(1, { error: PORT_MESSAGE }).max(65535, { error: PORT_MESSAGE }),
  branch: z.string().refine(isGitBranchName, { error: 'projects[].environment.branch must be a git branch name' }),
}).strict();

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
}).strict();

const CustomAgentDeclarations = z.array(CustomAgentDeclaration, { error: 'customAgents must be an array' })
  .superRefine((declarations, ctx) => {
    const claimedIds = new Set<string>(BUILTIN_AGENT_IDS);
    for (const [index, declaration] of declarations.entries()) {
      if (!claimedIds.has(declaration.id)) {
        claimedIds.add(declaration.id);
        continue;
      }
      const message = BUILTIN_AGENT_IDS.some((builtinAgentId) => builtinAgentId === declaration.id)
        ? `customAgents[${index}].id "${declaration.id}" collides with the builtin agent of the same id`
        : `customAgents[${index}].id "${declaration.id}" is declared more than once`;
      ctx.addIssue({ code: 'custom', path: [index, 'id'], message });
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

export const ProjectConfig = z.object({
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
  conversationView: z.boolean({ error: 'projects[].conversationView must be a boolean' }).optional(),
  dangerouslySkipPermissions: z.boolean({ error: 'projects[].dangerouslySkipPermissions must be a boolean' }).optional(),
  unguarded: z.boolean({ error: 'projects[].unguarded must be a boolean' }).optional(),
  saneYolo: z.boolean({ error: 'projects[].saneYolo must be a boolean' }).optional(),
  environment: ProjectEnvironment.optional(),
}).passthrough();
const FILE_CONFIG_SHAPE = {
  ...BROWSER_CONFIG_SHAPE,
  branchGc: optionalLooseObject('branchGc'),
  coder: CoderSettings,
  visions: optionalLooseObject('visions'),
  github: GithubSettings,
  teamReview: optionalLooseObject('teamReview'),
  benchmarks: optionalLooseObject('benchmarks'),
  coherence: optionalLooseObject('coherence'),
  issues: optionalLooseObject('issues'),
  posthog: optionalLooseObject('posthog'),
  usage: optionalLooseObject('usage'),
  telegram: optionalLooseObject('telegram'),
  ingest: optionalLooseObject('ingest'),
  workflows: optionalLooseObject('workflows'),
  guardrails: GuardrailsFileSettings,
  telemetry: TelemetryFileSettings,
  trace: TraceSettings,
  planReview: PlanReviewSettings,
  customAgents: CustomAgentDeclarations.optional(),
};
export const Config = z.object({
  ...FILE_CONFIG_SHAPE,
  detectScheduledWakeups: optionalBoolean('detectScheduledWakeups'),
  worktreeAutoRebase: optionalBoolean('worktreeAutoRebase'),
  worktreeSyncOnStart: optionalBoolean('worktreeSyncOnStart'),
  worktreeRerere: optionalBoolean('worktreeRerere'),
  hooks: z.unknown().optional(),
  remote: z.object({
    enabled: z.boolean().optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    publicHost: z.string().optional(),
    allowedOrigins: z.array(z.string()).optional(),
    ownerLogin: z.string().optional(),
  }).passthrough().optional(),
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
  const declaredEnvironmentNames = new Set((config.coder?.environments ?? []).map((environment) => environment.name));
  for (const [index, project] of config.projects.entries()) {
    const environmentName = project?.environment?.name;
    if (environmentName === undefined || declaredEnvironmentNames.has(environmentName)) continue;
    ctx.addIssue({
      code: 'custom',
      path: ['projects', index, 'environment', 'name'],
      message: `projects[${index}].environment "${environmentName}" must be declared under coder.environments`,
    });
  }
});

export const CONFIG_BLOCK_KEYS = Object.freeze([
  'taskTitle', 'branchGc', 'visions', 'github', 'teamReview', 'benchmarks', 'coherence', 'issues', 'posthog', 'usage', 'telegram', 'ingest',
  'guardrails', 'telemetry', 'workflows', 'coder',
]);
export const CONFIG_SCALAR_KEYS = Object.freeze(Object.keys(BROWSER_CONFIG_SHAPE).filter((key) => {
  if (CONFIG_BLOCK_KEYS.includes(key)) return false;
  return key !== 'port' && key !== 'repoRoots' && key !== 'worktreeShare';
}));
export const RUNTIME_CONFIG_SCALAR_KEYS = Object.freeze([
  ...CONFIG_SCALAR_KEYS,
  'worktreeAutoRebase',
  'worktreeSyncOnStart',
  'worktreeRerere',
]);
export const HIDDEN_CONFIG_KEYS = Object.freeze([
  'detectScheduledWakeups',
  'worktreeAutoRebase',
  'worktreeSyncOnStart',
  'worktreeRerere',
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
export type ProjectConfig = z.infer<typeof ProjectConfig>;
export type CustomAgentDeclaration = z.infer<typeof CustomAgentDeclaration>;
export type TaskTitleSources = z.infer<typeof TaskTitleSources>;
export type PersistedTaskTitle = z.infer<typeof PersistedTaskTitle>;
