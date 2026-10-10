import path from 'node:path';
import { z } from 'zod';
import { TaskTitle } from './session.ts';
import {
  FactorySettings, AgentApiFileSettings, BranchGcControlSettings, ChangeMapSettings,
  createBrowserConfig, optionalBoolean, optionalLooseObject,
  PlanReviewSettings, TelemetryFileSettings, TraceSettings,
} from './browser-config.ts';
import { WorkflowsSettingsUpdate } from './workflows.ts';
import type { BranchGcFileSettings as BranchGcFileSettingsSchema } from './browser-config.ts';

export {
  BRANCH_GC_CONTROL_BOOLEAN_KEYS, BRANCH_GC_CONTROL_NUMERIC_KEYS, CHANGE_MAP_NARRATOR_ENGINES,
  BranchGcFileSettings,
} from './browser-config.ts';

export const BrowserConfig = createBrowserConfig(path.isAbsolute);
const BROWSER_CONFIG_SHAPE = BrowserConfig.shape;
export const ConfigUpdate = z.object({
  ...BROWSER_CONFIG_SHAPE,
  autoRecoverSeconds: z.number({ error: 'autoRecoverSeconds must be a positive number' }).finite().positive({ error: 'autoRecoverSeconds must be a positive number' }).optional(),
  inputGraceSeconds: z.number({ error: 'inputGraceSeconds must be a positive number' }).finite().positive({ error: 'inputGraceSeconds must be a positive number' }).optional(),
  promptDetectionMs: z.number({ error: 'promptDetectionMs must be a positive number' }).finite().positive({ error: 'promptDetectionMs must be a positive number' }).optional(),
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
export const AGENT_COMMAND_SHAPE_MESSAGE = 'a bare command name or an absolute path, built only from letters, digits, dot, underscore, plus, dash and path separators';

function isSpawnableCommand(command: string): boolean {
  if (AGENT_COMMAND_BASENAME_RE.test(command)) return true;
  return AGENT_COMMAND_ABSOLUTE_RE.test(command);
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
}).strict();

export const CustomAgentDeclarations = z.array(CustomAgentDeclaration, { error: 'customAgents must be an array' })
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
  path: z.string(),
  repos: z.array(z.string()).min(2).optional(),
  agent: z.string({ error: 'projects[].agent must be a string' }).regex(AGENT_ID_RE, { error: `projects[].agent must be ${AGENT_ID_SHAPE_MESSAGE}` }).optional(),
  codexBypassHookTrust: z.boolean().optional(),
  dangerouslySkipPermissions: z.boolean({ error: 'projects[].dangerouslySkipPermissions must be a boolean' }).optional(),
}).passthrough();
const FILE_CONFIG_SHAPE = {
  ...BROWSER_CONFIG_SHAPE,
  changeMap: ChangeMapSettings,
  branchGc: optionalLooseObject('branchGc'),
  coder: z.object({ appSlug: z.string().optional() }).loose().optional(),
  visions: optionalLooseObject('visions'),
  teamReview: optionalLooseObject('teamReview'),
  benchmarks: optionalLooseObject('benchmarks'),
  factory: FactorySettings,
  knowledgeGraph: optionalLooseObject('knowledgeGraph'),
  posthog: optionalLooseObject('posthog'),
  usage: optionalLooseObject('usage'),
  telegram: optionalLooseObject('telegram'),
  ingest: optionalLooseObject('ingest'),
  workflows: optionalLooseObject('workflows'),
  agentApi: AgentApiFileSettings,
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
  postTurnChecks: z.record(z.string(), z.unknown()).optional(),
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
});

export const CONFIG_BLOCK_KEYS = Object.freeze([
  'changeMap', 'taskTitle', 'branchGc', 'postTurnChecks', 'visions', 'teamReview', 'benchmarks', 'factory', 'knowledgeGraph', 'posthog', 'usage', 'telegram', 'ingest',
  'agentApi', 'telemetry', 'workflows', 'coder',
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
