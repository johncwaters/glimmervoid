import { z } from 'zod';

export const LINK_SECRET_ENV = 'GLIMMERVOID_LINK_SECRET';
export const LINK_SERVER_URL_ENV = 'GLIMMERVOID_LINK_SERVER_URL';
export const WATCHER_HOME_ENV = 'GLIMMERVOID_WATCHER_HOME';
export const WATCHER_LISTENING_MESSAGE = 'watcher-listening';
export const NUDGES_PATH = '/link/nudges';
export const PROBE_SET_PATH = '/probe-set';
export const CREDENTIALS_PATH = '/credentials';
export const STATUS_PATH = '/status';
export const HEALTH_PATH = '/healthz';
const MIN_PROBE_INTERVAL_MS = 60_000;
export const MAX_LINK_BODY_BYTES = 1024 * 1024;

const ProbeCredential = z.enum(['github', 'posthog']);

export const Probe = z.strictObject({
  id: z.string().regex(/^[a-z0-9:._-]{1,120}$/),
  laneId: z.string().min(1).max(60),
  everyMs: z.number().int().min(MIN_PROBE_INTERVAL_MS),
  method: z.enum(['GET', 'POST']),
  url: z.url({ protocol: /^https$/ }),
  body: z.string().max(64 * 1024).nullable(),
  credential: ProbeCredential,
});
export type Probe = z.infer<typeof Probe>;

export const ProbeSet = z.strictObject({
  revision: z.string().min(1).max(128),
  probes: z.array(Probe).max(200).refine((probes) => new Set(probes.map((probe) => probe.id)).size === probes.length, 'probe ids must be unique'),
});
export type ProbeSet = z.infer<typeof ProbeSet>;

const ProbeFailure = z.strictObject({ status: z.number().int().nullable(), reason: z.string().max(500) });
export type ProbeFailure = z.infer<typeof ProbeFailure>;

export const Nudge = z.strictObject({
  nudgeId: z.uuid(),
  probeId: z.string().nullable(),
  kind: z.enum(['changed', 'failing', 'recovered', 'check-in']),
  failure: ProbeFailure.nullable(),
  at: z.iso.datetime(),
});
export type Nudge = z.infer<typeof Nudge>;

export const ProbeStatus = z.enum(['unknown', 'ok', 'failing']);
export type ProbeStatus = z.infer<typeof ProbeStatus>;

export const WatcherStatus = z.strictObject({
  probeSetRevision: z.string().nullable(),
  hasCredentials: z.strictObject({ github: z.boolean(), posthog: z.boolean() }),
  probes: z.array(z.strictObject({
    probeId: z.string(),
    status: ProbeStatus,
    lastRunAt: z.iso.datetime().nullable(),
    failure: ProbeFailure.nullable(),
  })),
});
export type WatcherStatus = z.infer<typeof WatcherStatus>;

export const WatcherCredentials = z.strictObject({
  github: z.string().min(1).nullable(),
  posthog: z.strictObject({ host: z.url({ protocol: /^https$/ }), apiKey: z.string().min(1) }).nullable(),
});
export type WatcherCredentials = z.infer<typeof WatcherCredentials>;

export const GITHUB_API_HOST = 'api.github.com';
