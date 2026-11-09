import { z } from 'zod';

export const DoormanTenant = z.strictObject({
  slug: z.string().regex(/^[a-z0-9]{12,40}$/),
  serverUrl: z.url({ protocol: /^https?$/ }),
  linkSecretPath: z.string().min(1),
  watcherHome: z.string().min(1),
});
export type DoormanTenant = z.infer<typeof DoormanTenant>;

export const DoormanTenantTable = z.strictObject({
  tenantDomain: z.string().regex(/^[a-z0-9.-]+$/).nullable(),
  tenants: z.array(DoormanTenant).min(1).refine((tenants) => new Set(tenants.map((tenant) => tenant.slug)).size === tenants.length, 'tenant slugs must be unique'),
}).refine((table) => table.tenantDomain !== null || table.tenants.length === 1, 'a table with no tenant domain holds exactly one tenant');
export type DoormanTenantTable = z.infer<typeof DoormanTenantTable>;
