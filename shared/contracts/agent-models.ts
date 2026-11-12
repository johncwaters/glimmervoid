import { z } from 'zod';

export const CATALOG_AGENT_IDS = ['claude-code', 'codex', 'kimi'] as const;
export const CatalogAgentId = z.enum(CATALOG_AGENT_IDS);
export type CatalogAgentId = z.infer<typeof CatalogAgentId>;

export const EFFORT_OPTION_ID = 'effort';
export const SAFE_LAUNCH_ARGUMENT_PATTERN = /^[A-Za-z0-9._:/[\]-]+$/;

export const AgentHomeKind = z.enum(['operator', 'clean']);
export type AgentHomeKind = z.infer<typeof AgentHomeKind>;

export const ModelOption = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  choices: z.array(z.string().min(1)).min(1),
  defaultChoice: z.string().min(1).nullable(),
});
export type ModelOption = z.infer<typeof ModelOption>;

export const CatalogModel = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  isDefault: z.boolean(),
  options: z.array(ModelOption),
});
export type CatalogModel = z.infer<typeof CatalogModel>;

export const AgentModels = z.strictObject({
  agent: CatalogAgentId,
  models: z.array(CatalogModel),
  error: z.string().nullable(),
  checkedAt: z.number().nullable(),
});
export type AgentModels = z.infer<typeof AgentModels>;

export const AgentModelCatalog = z.strictObject({
  agents: z.array(AgentModels),
});
export type AgentModelCatalog = z.infer<typeof AgentModelCatalog>;

const ModelOptionValue = z.strictObject({ id: z.string().min(1), value: z.string().min(1) });

export const ModelSelection = z.strictObject({
  agent: z.string().min(1),
  model: z.string().min(1).nullable(),
  options: z.array(ModelOptionValue),
});
export type ModelSelection = z.infer<typeof ModelSelection>;

export const AgentSetup = ModelSelection.extend({ instructions: z.string().max(4000) });
export type AgentSetup = z.infer<typeof AgentSetup>;

export const DEFAULT_MODELS = Object.freeze({
  taskTitleRefiner: 'haiku',
  communityJudge: 'haiku',
  questionManager: 'haiku',
  siteCapture: 'sonnet',
});
