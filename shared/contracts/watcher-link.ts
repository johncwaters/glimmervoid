import { z } from 'zod';
import { isLoopbackHostname, loopbackOverrideOrigin } from '../loopback-hosts.ts';

export const NUDGES_PATH = '/link/nudges';
export const WATCHER_PATH_PREFIX = '/link/watcher/';
export const PROBE_SET_PATH = `${WATCHER_PATH_PREFIX}probe-set`;
export const CREDENTIALS_PATH = `${WATCHER_PATH_PREFIX}credentials`;
export const STATUS_PATH = `${WATCHER_PATH_PREFIX}status`;
export const HEALTH_PATH = `${WATCHER_PATH_PREFIX}healthz`;
export const HOST_STOP_PATH = `${WATCHER_PATH_PREFIX}host-stop`;
export const GITHUB_TOKEN_PATH = `${WATCHER_PATH_PREFIX}github-token`;
const MIN_PROBE_INTERVAL_MS = 60_000;
export const MAX_LINK_BODY_BYTES = 1024 * 1024;

export function isLinkUrlSafe(rawUrl: string): boolean {
  const linkUrl = URL.parse(rawUrl);
  if (linkUrl === null) return false;
  if (linkUrl.protocol === 'https:') return true;
  return linkUrl.protocol === 'http:' && isLoopbackHostname(linkUrl.hostname);
}

export const WATCHER_LANE_IDS = Object.freeze(['github-store', 'issues', 'radar', 'community'] as const);
export const PROBE_CREDENTIALS = Object.freeze(['github', 'posthog'] as const);
const ProbeCredential = z.enum(PROBE_CREDENTIALS);

const ProbeUrl = z.url({ protocol: /^https?$/ }).refine(
  (probeUrl) => probeUrl.startsWith('https:') || isLoopbackHostname(URL.parse(probeUrl)?.hostname ?? ''),
  'a probe reaches an https address, or plain http only on a loopback address',
);

export const Probe = z.strictObject({
  id: z.string().regex(/^[a-z0-9:._-]{1,120}$/),
  laneId: z.string().min(1).max(60),
  everyMs: z.number().int().min(MIN_PROBE_INTERVAL_MS),
  method: z.enum(['GET', 'POST']),
  url: ProbeUrl,
  body: z.string().max(64 * 1024).nullable(),
  credential: ProbeCredential,
  answerField: z.string().regex(/^[a-z_]{1,40}$/).optional(),
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
  nudgesFailingForMs: z.number().int().nonnegative().nullable(),
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

const GITHUB_API_ORIGIN = 'https://api.github.com';
export const GITHUB_API_BASE_ENV = 'GLIMMERVOID_GITHUB_API_BASE';

export function githubApiOrigin(environment: Readonly<Record<string, string | undefined>>): string {
  return loopbackOverrideOrigin(environment[GITHUB_API_BASE_ENV], GITHUB_API_ORIGIN);
}

export const HostStopAnswer = z.strictObject({ outcome: z.enum(['stopping', 'no-adapter']) });
export type HostStopOutcome = z.infer<typeof HostStopAnswer>['outcome'];

export const GithubTokenGrant = z.strictObject({ token: z.string().min(1), expiresAtMs: z.number().int().positive() });
export type GithubTokenGrant = z.infer<typeof GithubTokenGrant>;
export const GithubTokenAnswer = z.strictObject({ grant: GithubTokenGrant.nullable() });
export type GithubTokenAnswer = z.infer<typeof GithubTokenAnswer>;
