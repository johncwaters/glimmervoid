import path from 'node:path';
import type { GlimmervoidConfig } from '../config-store.ts';
import { glimmervoidHomeDir } from '../config-store.ts';
import { createJsonStateStore } from '../json-file.ts';
import { createLaneRunner } from '../lanes/lane-runner.ts';
import { emptyLaneStatus } from '../lanes/lane-status.ts';
import { bootStaggerDelay } from '../boot-stagger.ts';
import { stableConfigKey } from '../core/config-secrets-core.ts';
import { createPosthogApi, extractRows } from '../radar/posthog-api.ts';
import type { PosthogApi } from '../radar/posthog-api.ts';
import * as core from './core/community-core.ts';
import { createCommunityPoller } from './community-poller.ts';
import type { SourceRows } from './community-poller.ts';
import { CommunityState } from '../../shared/contracts/community.ts';

function createCommunityStateIo(statePath: string, log: Pick<Console, 'warn'>) {
  let loaded = core.emptyCommunityState();
  const warn = (message: string) => log.warn(`[${core.COMMUNITY_LANE_ID}] ${message}`);
  const store = createJsonStateStore<CommunityState>({
    name: 'community state',
    filePath: statePath,
    parse: (raw) => core.parseCommunityState(raw, warn),
    adopt: (value) => { loaded = value ?? core.emptyCommunityState(); },
    warn: (message, fields) => warn(`${message} ${JSON.stringify(fields)}`),
  });
  return {
    async readState(): Promise<CommunityState> {
      await store.load();
      return loaded;
    },
    async writeState(state: CommunityState): Promise<void> {
      const parsed = CommunityState.parse(state);
      await store.write(parsed, () => `${JSON.stringify(parsed, null, 2)}\n`);
      loaded = parsed;
    },
  };
}

function hogQLRows(api: PosthogApi, projectId: number, query: string, values: Record<string, unknown>): Promise<SourceRows> {
  return api.runHogQL(projectId, query, values).then((response) => {
    if (!response.ok) return { ok: false, error: response.error };
    return { ok: true, rows: extractRows(response.body) };
  });
}

interface CommunityWiringOptions {
  config: GlimmervoidConfig;
  broadcast?: (status: Record<string, unknown>) => void;
  homeDir?: string;
  createApi?: (connection: core.PosthogConnection) => PosthogApi;
  log?: Pick<Console, 'warn'>;
}

function createCommunityWiring({
  config, broadcast = () => {}, homeDir = glimmervoidHomeDir(),
  createApi = (connection) => createPosthogApi(connection), log = console,
}: CommunityWiringOptions) {
  const stateIo = createCommunityStateIo(path.join(homeDir, core.COMMUNITY_STATE_FILENAME), log);

  const runner = createLaneRunner({
    tag: core.COMMUNITY_LANE_ID,
    gate: () => core.communityGate(config),
    cfgKey: () => stableConfigKey({ community: config.community ?? null, posthog: core.readPosthogConnection(config) }),
    emptyStatus: () => ({ ...emptyLaneStatus('community-status', core.communityGate(config)), entries: [] }),
    broadcast,
    createPoller: ({ onTickComplete }) => {
      const connection = core.readPosthogConnection(config);
      if (!connection) throw new Error('Community poller started without a PostHog apiKey');
      const settings = core.readCommunitySettings(config);
      const api = createApi(connection);
      return createCommunityPoller({
        intervalMinutes: settings.intervalMinutes,
        queryForum: (sinceIso) => hogQLRows(api, settings.projectId, core.forumQuery(), { since: sinceIso }),
        readState: stateIo.readState,
        writeState: stateIo.writeState,
        onTickComplete,
        firstTickDelayMs: bootStaggerDelay,
        log,
      });
    },
  });

  return {
    startPoller: runner.startPoller,
    stopPoller: runner.stopPoller,
    restartIfConfigChanged: runner.restartIfConfigChanged,
    getStatus: runner.getStatus,
    getPoller: runner.getPoller,
  };
}

export { createCommunityStateIo, createCommunityWiring };
