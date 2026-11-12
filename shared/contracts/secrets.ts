import { z } from 'zod';

export const MAX_NAMES_PER_NEED = 32;
export const MAX_REFERENCE_LENGTH = 2048;
export const VAULT_SOCKET_PATH = '/vault';
export const VAULT_REPLACED_CLOSE_CODE = 4000;

export const SecretName = z.string({ error: 'a secret name must be a string' })
  .regex(/^[A-Z_][A-Z0-9_]{0,127}$/, { error: 'a secret name must be an environment variable name in capitals, for example OPENAI_API_KEY' });

const NEED_STATUSES = ['delivered', 'pending', 'denied', 'companion-offline', 'failed'] as const;
export const NeedStatus = z.enum(NEED_STATUSES);

export const AgentNeedRequest = z.object({
  names: z.array(SecretName, { error: 'names must be a list of secret names' })
    .min(1, { error: 'name at least one secret' })
    .max(MAX_NAMES_PER_NEED, { error: `name at most ${MAX_NAMES_PER_NEED} secrets at once` }),
}).strict();

const NeedResult = z.object({
  name: SecretName,
  status: NeedStatus,
  note: z.string(),
}).strict();

export const AgentNeedReply = z.object({
  ok: z.literal(true),
  results: z.array(NeedResult),
  envFile: z.string().nullable(),
}).strict();

export const SecretApproval = z.object({
  reference: z.string().min(1).max(MAX_REFERENCE_LENGTH).nullable(),
  isAllowed: z.boolean(),
}).passthrough();

const MAX_SECRET_VALUE_LENGTH = 65536;
export const MAX_VAULT_NAME_LENGTH = 200;

export const SecretDecision = z.object({
  id: z.string().min(1),
  isAllowed: z.boolean(),
  referenceByName: z.record(SecretName, z.string().trim().max(MAX_REFERENCE_LENGTH)).default({}),
  valueByName: z.record(SecretName, z.string().max(MAX_SECRET_VALUE_LENGTH)).default({}),
  newItemsVault: z.string().trim().max(MAX_VAULT_NAME_LENGTH).default(''),
}).strict();

export const SecretRevoke = z.object({
  project: z.string().min(1),
  name: SecretName,
}).strict();

const ApprovalRow = z.object({
  name: SecretName,
  reference: z.string().nullable(),
  isAllowed: z.boolean(),
}).strict();

export const ProjectApprovals = z.object({
  project: z.string(),
  approvals: z.array(ApprovalRow),
}).strict();

export const PackSecretRow = z.object({
  name: SecretName,
  packs: z.array(z.string()),
  reference: z.string().nullable(),
}).strict();

export const PackSecretLink = z.object({
  name: SecretName,
  reference: z.string().trim().max(MAX_REFERENCE_LENGTH),
}).strict();

const VAULT_FAILURE_KINDS = ['not-found', 'locked', 'denied', 'unavailable'] as const;

const VaultFailure = z.object({
  kind: z.enum(VAULT_FAILURE_KINDS),
  message: z.string().max(500),
}).strict();

const JOB_ID = z.string().min(1).max(64);

const ResolveJob = z.object({
  type: z.literal('resolve'),
  jobId: JOB_ID,
  items: z.array(z.object({ name: SecretName, reference: z.string().min(1).max(MAX_REFERENCE_LENGTH) }).strict()).min(1).max(MAX_NAMES_PER_NEED),
}).strict();

const CreateJob = z.object({
  type: z.literal('create'),
  jobId: JOB_ID,
  items: z.array(z.object({
    name: SecretName,
    title: z.string().min(1).max(MAX_VAULT_NAME_LENGTH),
    value: z.string().min(1).max(MAX_SECRET_VALUE_LENGTH),
    vaultName: z.string().max(MAX_VAULT_NAME_LENGTH),
  }).strict()).min(1).max(MAX_NAMES_PER_NEED),
}).strict();

export const VaultJob = z.discriminatedUnion('type', [ResolveJob, CreateJob]);

const FailedItem = z.object({ name: SecretName, failure: VaultFailure }).strict();

const ResolvedResult = z.object({
  type: z.literal('resolved'),
  jobId: JOB_ID,
  items: z.array(z.union([z.object({ name: SecretName, value: z.string().max(MAX_SECRET_VALUE_LENGTH) }).strict(), FailedItem])).max(MAX_NAMES_PER_NEED),
}).strict();

const CreatedResult = z.object({
  type: z.literal('created'),
  jobId: JOB_ID,
  items: z.array(z.union([z.object({ name: SecretName, reference: z.string().min(1).max(MAX_REFERENCE_LENGTH) }).strict(), FailedItem])).max(MAX_NAMES_PER_NEED),
}).strict();

const CompanionHello = z.object({
  type: z.literal('hello'),
  newItemsVault: z.string().max(MAX_VAULT_NAME_LENGTH).nullable(),
}).strict();

export const VaultCompanionMessage = z.discriminatedUnion('type', [ResolvedResult, CreatedResult, CompanionHello]);

export const VaultCompanionFile = z.object({
  url: z.string().url(),
  token: z.string().min(1).optional(),
}).strict();

export type SecretName = z.infer<typeof SecretName>;
export type NeedStatus = z.infer<typeof NeedStatus>;
export type AgentNeedRequest = z.infer<typeof AgentNeedRequest>;
export type AgentNeedReply = z.infer<typeof AgentNeedReply>;
export type SecretApproval = z.infer<typeof SecretApproval>;
export type SecretDecision = z.infer<typeof SecretDecision>;
export type SecretRevoke = z.infer<typeof SecretRevoke>;
export type ProjectApprovals = z.infer<typeof ProjectApprovals>;
export type PackSecretRow = z.infer<typeof PackSecretRow>;
export type PackSecretLink = z.infer<typeof PackSecretLink>;
export type VaultFailure = z.infer<typeof VaultFailure>;
export type VaultJob = z.infer<typeof VaultJob>;
export type VaultCompanionMessage = z.infer<typeof VaultCompanionMessage>;
export type ResolveJob = z.infer<typeof ResolveJob>;
export type CreateJob = z.infer<typeof CreateJob>;
export type ResolvedResult = z.infer<typeof ResolvedResult>;
export type CreatedResult = z.infer<typeof CreatedResult>;
export type VaultCompanionFile = z.infer<typeof VaultCompanionFile>;
