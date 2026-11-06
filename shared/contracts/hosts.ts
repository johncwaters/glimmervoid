import { z } from 'zod';

const HOST_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SSH_TARGET_RE = /^(?!-)[A-Za-z0-9._@:[\]-]{1,255}$/;

export const HostEntry = z.object({
  id: z.string().regex(HOST_ID_RE, { error: 'host id must be 1 to 32 lowercase letters, digits and dashes, starting with a letter' }),
  name: z.string().min(1).max(60),
  sshTarget: z.string().regex(SSH_TARGET_RE, { error: 'host sshTarget must be an ssh host or alias that does not start with a dash' }),
  dashboardPort: z.number().int().min(1).max(65535),
}).strict();

export const HostEntries = z.array(HostEntry).superRefine((hosts, ctx) => {
  const seenIds = new Set<string>();
  for (const [index, host] of hosts.entries()) {
    if (seenIds.has(host.id)) ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `hosts[${index}].id "${host.id}" is used by another host` });
    seenIds.add(host.id);
  }
});

export const HostLinkState = z.enum(['connecting', 'connected', 'reconnecting', 'unreachable', 'version-differs']);

export const HostStatus = z.object({
  id: z.string(),
  name: z.string(),
  state: HostLinkState,
  hostVersion: z.string().nullable(),
  hubVersion: z.string(),
  lastError: z.string().nullable(),
}).strict();

export const HUB_PHONE_ALERT_TEXT_MAX = 4000;

export const HubPhoneAlertFrame = z.object({
  type: z.literal('hub-phone-alert'),
  text: z.string().min(1).max(HUB_PHONE_ALERT_TEXT_MAX),
}).strict();

export type HostEntry = z.infer<typeof HostEntry>;
export type HostLinkState = z.infer<typeof HostLinkState>;
export type HostStatus = z.infer<typeof HostStatus>;
export type HubPhoneAlertFrame = z.infer<typeof HubPhoneAlertFrame>;
