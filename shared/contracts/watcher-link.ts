import { z } from 'zod';
import { isLoopbackHostname, loopbackOverrideOrigin } from '../loopback-hosts.ts';

export const NUDGES_PATH = '/link/nudges';
export const WATCHER_PATH_PREFIX = '/link/watcher/';
export const WATCHER_FEATURES_HEADER = 'x-glimmervoid-watcher-features';
export const ALARMS_FEATURE = 'alarms';
export const PROBE_SET_PATH = `${WATCHER_PATH_PREFIX}probe-set`;
export const CREDENTIALS_PATH = `${WATCHER_PATH_PREFIX}credentials`;
export const STATUS_PATH = `${WATCHER_PATH_PREFIX}status`;
export const HEALTH_PATH = `${WATCHER_PATH_PREFIX}healthz`;
export const HOST_STOP_PATH = `${WATCHER_PATH_PREFIX}host-stop`;
export const GITHUB_TOKEN_PATH = `${WATCHER_PATH_PREFIX}github-token`;
export const AWAKE_USAGE_PATH = `${WATCHER_PATH_PREFIX}awake-usage`;
export const GITHUB_CONNECT_PATH = `${WATCHER_PATH_PREFIX}github-connect`;
export const GITHUB_CONNECTION_PATH = `${WATCHER_PATH_PREFIX}github-connection`;
export const GITHUB_DISCONNECT_PATH = `${WATCHER_PATH_PREFIX}github-disconnect`;
const MIN_PROBE_INTERVAL_MS = 60_000;
export const MAX_LINK_BODY_BYTES = 1024 * 1024;

export function isLinkUrlSafe(rawUrl: string): boolean {
  const linkUrl = URL.parse(rawUrl);
  if (linkUrl === null) return false;
  if (linkUrl.protocol === 'https:') return true;
  return linkUrl.protocol === 'http:' && isLoopbackHostname(linkUrl.hostname);
}

export const WATCHER_LANE_IDS = Object.freeze(['github-store', 'radar', 'community'] as const);
export const PROBE_CREDENTIALS = Object.freeze(['github', 'posthog'] as const);
const ProbeCredential = z.enum(PROBE_CREDENTIALS);

const ProbeUrl = z.url({ protocol: /^https?$/ }).refine(
  (probeUrl) => probeUrl.startsWith('https:') || isLoopbackHostname(URL.parse(probeUrl)?.hostname ?? ''),
  'a probe reaches an https address, or plain http only on a loopback address',
);

export const GithubLogin = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);

export const Probe = z.strictObject({
  id: z.string().regex(/^[a-z0-9:._-]{1,120}$/),
  laneId: z.string().min(1).max(60),
  everyMs: z.number().int().min(MIN_PROBE_INTERVAL_MS),
  method: z.enum(['GET', 'POST']),
  url: ProbeUrl,
  body: z.string().max(64 * 1024).nullable(),
  credential: ProbeCredential,
  answerField: z.string().regex(/^[a-z_]{1,40}$/).optional(),
  githubOwner: GithubLogin.optional(),
});
export type Probe = z.infer<typeof Probe>;

export const MAX_ALARMS = 200;

export const Alarm = z.strictObject({
  id: z.string().regex(/^[a-z0-9:._-]{1,120}$/),
  at: z.iso.datetime(),
});
export type Alarm = z.infer<typeof Alarm>;

export const ProbeSet = z.strictObject({
  revision: z.string().min(1).max(128),
  probes: z.array(Probe).max(200).refine((probes) => new Set(probes.map((probe) => probe.id)).size === probes.length, 'probe ids must be unique'),
  alarms: z.array(Alarm).max(MAX_ALARMS).optional(),
});
export type ProbeSet = z.infer<typeof ProbeSet>;

const ProbeFailure = z.strictObject({ status: z.number().int().nullable(), reason: z.string().max(500) });
export type ProbeFailure = z.infer<typeof ProbeFailure>;

export const Nudge = z.strictObject({
  nudgeId: z.uuid(),
  probeId: z.string().nullable(),
  kind: z.enum(['changed', 'failing', 'recovered', 'check-in', 'alarm']),
  failure: ProbeFailure.nullable(),
  at: z.iso.datetime(),
});
export type Nudge = z.infer<typeof Nudge>;

export const ProbeStatus = z.enum(['unknown', 'ok', 'failing']);
export type ProbeStatus = z.infer<typeof ProbeStatus>;

export const AwakeUsage = z.strictObject({
  usedMs: z.number().int().nonnegative(),
  capMs: z.number().int().positive().nullable(),
  periodStartAt: z.iso.datetime(),
  periodEndsAt: z.iso.datetime(),
});
export type AwakeUsage = z.infer<typeof AwakeUsage>;

export const AwakeUsageAnswer = z.strictObject({ awakeUsage: AwakeUsage.nullable() });

export const AwakeUsageNotified = z.strictObject({
  periodStartAt: z.iso.datetime(),
  capMs: z.number().int().positive(),
  threshold: z.number().int().positive(),
});
export type AwakeUsageNotified = z.infer<typeof AwakeUsageNotified>;

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

const PositiveInt = z.number().int().positive();
export const MAX_BOUND_INSTALLATIONS = 100;

export const GithubTokenGrant = z.strictObject({ accountLogin: GithubLogin, token: z.string().min(1), expiresAtMs: PositiveInt });
export type GithubTokenGrant = z.infer<typeof GithubTokenGrant>;
export const GithubUserGrant = z.strictObject({ login: GithubLogin, token: z.string().min(1), expiresAtMs: PositiveInt });
export type GithubUserGrant = z.infer<typeof GithubUserGrant>;
export const GithubTokenAnswer = z.strictObject({ grants: z.array(GithubTokenGrant).max(MAX_BOUND_INSTALLATIONS), user: GithubUserGrant.nullable() });
export type GithubTokenAnswer = z.infer<typeof GithubTokenAnswer>;
export const GithubReconnectReason = z.enum(['expired', 'revoked']);
export type GithubReconnectReason = z.infer<typeof GithubReconnectReason>;

export const GithubConnection = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('unavailable'), reason: z.enum(['no-app', 'device-flow-off', 'user-tokens-never-expire']) }),
  z.strictObject({ state: z.literal('disconnected') }),
  z.strictObject({ state: z.literal('awaiting-code'), userCode: z.string().min(1).max(20), verificationUri: z.url({ protocol: /^https$/ }), expiresAtMs: PositiveInt }),
  z.strictObject({ state: z.literal('needs-install'), login: GithubLogin, installUrl: z.url({ protocol: /^https$/ }) }),
  z.strictObject({ state: z.literal('connected'), login: GithubLogin, accounts: z.array(GithubLogin).max(MAX_BOUND_INSTALLATIONS), refreshTokenExpiresAtMs: PositiveInt, installUrl: z.url({ protocol: /^https$/ }) }),
  z.strictObject({ state: z.literal('reconnect-needed'), login: GithubLogin, reason: GithubReconnectReason }),
]);
export type GithubConnection = z.infer<typeof GithubConnection>;
export const GithubConnectionNotified = z.strictObject({
  expiringRefreshTokenExpiresAtMs: PositiveInt.nullable(),
  reconnectNeededLogin: GithubLogin.nullable(),
});
export type GithubConnectionNotified = z.infer<typeof GithubConnectionNotified>;

export const GithubConnectionAction = z.enum(['read', 'connect', 'disconnect']);
export type GithubConnectionAction = z.infer<typeof GithubConnectionAction>;

export const GithubConnectionAnswer = z.strictObject({ connection: GithubConnection });
export type GithubConnectionAnswer = z.infer<typeof GithubConnectionAnswer>;
