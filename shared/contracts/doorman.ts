import { z } from 'zod';

export const DoormanGithubApp = z.strictObject({
  clientId: z.string().regex(/^[A-Za-z0-9.]{1,64}$/),
  privateKeySecret: z.string().regex(/^projects\/[a-z0-9-]{1,63}\/secrets\/[A-Za-z0-9_-]{1,255}$/),
});
export type DoormanGithubApp = z.infer<typeof DoormanGithubApp>;

export const DoormanGithubInstallation = z.strictObject({
  installationId: z.number().int().positive(),
  repositories: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,100}$/)).max(500).default([]),
});
export type DoormanGithubInstallation = z.infer<typeof DoormanGithubInstallation>;

export const DoormanTenant = z.strictObject({
  slug: z.string().regex(/^[a-z0-9]{12,40}$/),
  serverUrl: z.url({ protocol: /^https?$/ }),
  linkSecretPath: z.string().min(1),
  watcherHome: z.string().min(1),
  githubInstallation: DoormanGithubInstallation.nullable().default(null),
});
export type DoormanTenant = z.infer<typeof DoormanTenant>;

export const DoormanTenantTable = z.strictObject({
  tenantDomain: z.string().regex(/^[a-z0-9.-]+$/).nullable(),
  githubApp: DoormanGithubApp.nullable().default(null),
  tenants: z.array(DoormanTenant).min(1).refine((tenants) => new Set(tenants.map((tenant) => tenant.slug)).size === tenants.length, 'tenant slugs must be unique'),
}).refine((table) => table.tenantDomain !== null || table.tenants.length === 1, 'a table with no tenant domain holds exactly one tenant');
export type DoormanTenantTable = z.infer<typeof DoormanTenantTable>;

export const DOORMAN_LOCK_FILE_NAME = 'doorman.lock';
export const DOORMAN_PORT_FILE_NAME = 'port';
export type DoormanTenantTableInput = z.input<typeof DoormanTenantTable>;
