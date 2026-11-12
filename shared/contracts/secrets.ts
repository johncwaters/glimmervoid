import { z } from 'zod';

export const MAX_NAMES_PER_NEED = 32;

export const SecretName = z.string({ error: 'a secret name must be a string' })
  .regex(/^[A-Z_][A-Z0-9_]{0,127}$/, { error: 'a secret name must be an environment variable name in capitals, for example OPENAI_API_KEY' });

const MAX_LOOK_IN_LENGTH = 200;

export const SecretManager = z.enum(['1password']);

export const SECRET_MANAGER_LABELS: Readonly<Record<z.infer<typeof SecretManager>, string>> = Object.freeze({ '1password': '1Password' });

export const SecretLookIn = z.string({ error: 'vault.lookIn must be a string' }).trim()
  .max(MAX_LOOK_IN_LENGTH, { error: `vault.lookIn must be at most ${MAX_LOOK_IN_LENGTH} characters` })
  .regex(/^\P{Cc}*$/u, { error: 'vault.lookIn cannot hold control characters' });

export const SecretSource = z.object({
  manager: SecretManager,
  lookIn: SecretLookIn.min(1, { error: 'Type the vault to look in first' }),
}).strict();

export const SecretSourceTestResult = z.object({ ok: z.boolean(), message: z.string(), detail: z.string() }).strict();

const NEED_STATUSES = ['delivered', 'pending', 'denied', 'no-source', 'failed'] as const;
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
  isAllowed: z.boolean(),
}).strict();


export const WrittenSecretNames = z.object({
  version: z.literal(1),
  namesByDirectory: z.record(z.string(), z.array(SecretName)),
}).strict();

export const SecretDecision = z.object({
  id: z.string().min(1),
  choice: z.enum(['deny', 'allow-once', 'allow-always']),
  names: z.array(SecretName).min(1).max(MAX_NAMES_PER_NEED),
}).strict();

const SECRET_REQUEST_PHASES = ['needs-source', 'asking', 'reading', 'failed'] as const;

export const SecretRequestCard = z.object({
  names: z.array(SecretName),
  reason: z.string().nullable(),
  phase: z.enum(SECRET_REQUEST_PHASES),
  readingName: SecretName.nullable(),
  from: z.string().nullable(),
  failure: z.object({ message: z.string(), detail: z.string() }).strict().nullable(),
}).strict();

export const SecretRevoke = z.object({
  project: z.string().min(1),
  name: SecretName,
}).strict();

const ApprovalRow = z.object({
  name: SecretName,
  isAllowed: z.boolean(),
}).strict();

export const ProjectApprovals = z.object({
  project: z.string(),
  approvals: z.array(ApprovalRow),
}).strict();

export type SecretName = z.infer<typeof SecretName>;
export type SecretManager = z.infer<typeof SecretManager>;
export type SecretSource = z.infer<typeof SecretSource>;
export type SecretSourceTestResult = z.infer<typeof SecretSourceTestResult>;
export type NeedStatus = z.infer<typeof NeedStatus>;
export type AgentNeedRequest = z.infer<typeof AgentNeedRequest>;
export type AgentNeedReply = z.infer<typeof AgentNeedReply>;
export type SecretApproval = z.infer<typeof SecretApproval>;
export type SecretDecision = z.infer<typeof SecretDecision>;
export type WrittenSecretNames = z.infer<typeof WrittenSecretNames>;
export type SecretRequestCard = z.infer<typeof SecretRequestCard>;
export type SecretRevoke = z.infer<typeof SecretRevoke>;
export type ProjectApprovals = z.infer<typeof ProjectApprovals>;
