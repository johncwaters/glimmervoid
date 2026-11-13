import { z } from 'zod';

const SecretManagerSecretName = z.string().regex(/^projects\/[a-z0-9-]{1,63}\/secrets\/[A-Za-z0-9_-]{1,255}$/);

export const DoormanGithubApp = z.strictObject({
  clientId: z.string().regex(/^[A-Za-z0-9.]{1,64}$/),
  slug: z.string().regex(/^[a-z0-9-]{1,34}$/),
  privateKeySecret: SecretManagerSecretName.nullable(),
});
export type DoormanGithubApp = z.infer<typeof DoormanGithubApp>;

export const OFFICIAL_GITHUB_APP = { clientId: 'Iv23li7oS6MEgm5FoQ2d', slug: 'glimmervoid-cloud' } as const;

export const DoormanGcpHost = z.strictObject({
  kind: z.literal('gcp'),
  project: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  zone: z.string().regex(/^[a-z]+-[a-z]+[0-9]+-[a-z]$/),
  instance: z.string().regex(/^tenant-[-a-z0-9]{0,55}[a-z0-9]$/),
});
export type DoormanGcpHost = z.infer<typeof DoormanGcpHost>;

const DoormanLinkSecret = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), path: z.string().min(1) }),
  z.strictObject({ kind: z.literal('secret-manager'), secret: SecretManagerSecretName }),
]);

export const DoormanTenant = z.strictObject({
  slug: z.string().regex(/^[a-z0-9]{12,40}$/),
  serverUrl: z.url({ protocol: /^https?$/ }),
  linkSecret: DoormanLinkSecret,
  watcherHome: z.string().min(1).nullable(),
  awakeHoursPerMonth: z.number().positive().nullable().default(null),
  host: DoormanGcpHost.nullable().default(null),
});
export type DoormanTenant = z.infer<typeof DoormanTenant>;

export const DoormanTenantTable = z.strictObject({
  tenantDomain: z.string().regex(/^[a-z0-9.-]+$/).nullable(),
  githubApp: DoormanGithubApp.nullable().default(null),
  tenants: z.array(DoormanTenant).min(1).refine((tenants) => new Set(tenants.map((tenant) => tenant.slug)).size === tenants.length, 'tenant slugs must be unique'),
}).refine((table) => table.tenantDomain !== null || table.tenants.length === 1, 'a table with no tenant domain holds exactly one tenant');
export type DoormanTenantTable = z.infer<typeof DoormanTenantTable>;

export const DoormanTableServerUrls = z.object({ tenants: z.array(DoormanTenant.pick({ serverUrl: true })) });

export const WakeStartedBy = z.enum(['edge', 'watcher']);
export type WakeStartedBy = z.infer<typeof WakeStartedBy>;

export const AwakeEvent = z.strictObject({
  event: z.enum(['woke', 'observed-awake', 'slept']),
  at: z.iso.datetime(),
  startedBy: WakeStartedBy.optional(),
});
export type AwakeEvent = z.infer<typeof AwakeEvent>;

export const DOORMAN_LOCK_FILE_NAME = 'doorman.lock';
export const DOORMAN_PORT_FILE_NAME = 'port';
export type DoormanTenantTableInput = z.input<typeof DoormanTenantTable>;
