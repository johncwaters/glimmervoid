import { communityProbes } from './community-probes.ts';
import type { Probe } from '../../shared/contracts/watcher-link.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GlimmervoidConfig } from '../config-store.ts';
import type { HookToolConfig } from '../hook-tools.ts';
import { glimmervoidHomeDir } from '../config-store.ts';
import { createJsonStateStore } from '../json-file.ts';
import { createLaneRunner } from '../lanes/lane-runner.ts';
import { emptyLaneStatus } from '../lanes/lane-status.ts';
import { bootStaggerDelay } from '../boot-stagger.ts';
import { stableConfigKey } from '../core/config-secrets-core.ts';
import type { LaneAccessConfig } from '../lanes/core/lane-permissions-core.ts';
import { createPosthogApi, extractRows } from '../radar/posthog-api.ts';
import type { PosthogApi } from '../radar/posthog-api.ts';
import * as core from './core/community-core.ts';
import { createCommunityPoller } from './community-poller.ts';
import type { DiscordSource, SourceRows } from './community-poller.ts';
import { COMMUNITY_JUDGE_TOOLS, createCommunityJudge } from './community-judge.ts';
import { createLaneSpawn } from '../lanes/lane-spawn.ts';
import { writeUntrustedPayload } from '../lanes/untrusted-payload.ts';
import { sendTelegramMessage } from '../telegram-transport.ts';
import { decideTelegramNotification } from '../../notifications/channels/telegram.ts';
import { CommunityState } from '../../shared/contracts/community.ts';
import type { CommunityActionRequest, CommunityActionResult, CommunityStateEntry } from '../../shared/contracts/community.ts';
import { errorMessage } from '../../shared/text.ts';
import { TEAM_REVIEW_SESSION_DENY_RULES, createTeamReviewSpawn } from '../github/team-review-spawn.ts';
import { absolutePathReadRule } from '../github/core/team-review-core.ts';
import { ACCEPT_EDITS_MODE, laneAccessConfigOf } from '../lanes/core/lane-permissions-core.ts';
import { firstLine, raceWithAbort } from '../lanes/ephemeral-session.ts';
import type { RecordLane, SpawnGate } from '../lanes/ephemeral-session.ts';
import type { HookRouter } from '../../detection/hook-source.ts';
import { clock } from '../../shared/clock.ts';

const COMMUNITY_WORK_DIRNAME = 'community-work';
const RESULT_MAX_BYTES = 1024 * 1024;

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
    if (!response.ok) return { ok: false, error: response.error, isRateLimited: 'status' in response && response.status === 429, retryAfterMs: 'retryAfterMs' in response ? response.retryAfterMs : undefined };
    return { ok: true, rows: extractRows(response.body) };
  });
}

function communityClaudeArgs(workDir: string): string[] {
  const workDirReadRules = ['Read', 'Glob', 'Grep'].map((tool) => absolutePathReadRule(workDir).replace(/^Read/, tool));
  return ['-p', '--allowedTools', ...workDirReadRules, '--disallowedTools', ...TEAM_REVIEW_SESSION_DENY_RULES];
}

function communityAcceptEditsPermissions(): { deny: string[]; defaultMode: string } {
  return { deny: [...TEAM_REVIEW_SESSION_DENY_RULES], defaultMode: ACCEPT_EDITS_MODE };
}

function communitySpawnEnv(): Record<string, string> {
  return {
    GLIMMERVOID_POSTHOG_API_KEY: '',
    GLIMMERVOID_TELEGRAM_BOT_TOKEN: '',
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
  };
}

async function readBoundedFile(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > RESULT_MAX_BYTES) return null;
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

interface CommunitySpawnDependencies {
  investigationSessions: Map<string, unknown>;
  closeSessionDataClients: (id: string) => void;
  hookRouter: Pick<HookRouter, 'register' | 'unregister'> | null;
  getHookPort: (() => number | null) | null;
  spawnGate: SpawnGate;
  recordLane?: RecordLane | null;
  replayBufferKB?: number;
}

function createCommunityRunner({ spawnDependencies, homeDir, getSettings, hookToolConfig, getLaneAccessConfig }: {
  spawnDependencies: CommunitySpawnDependencies;
  homeDir: string;
  hookToolConfig: HookToolConfig;
  getLaneAccessConfig: () => LaneAccessConfig;
  getSettings: () => core.CommunitySettings;
}) {
  const spawnSession = createTeamReviewSpawn({
    reviewSessions: spawnDependencies.investigationSessions,
    closeSessionDataClients: spawnDependencies.closeSessionDataClients,
    hookRouter: spawnDependencies.hookRouter,
    getHookPort: spawnDependencies.getHookPort,
    spawnGate: spawnDependencies.spawnGate,
    recordLane: spawnDependencies.recordLane ?? null,
    replayBufferKB: spawnDependencies.replayBufferKB,
    laneName: core.COMMUNITY_LANE_ID,
    hookToolConfig,
    getLaneAccessConfig,
  });
  const workRoot = path.join(homeDir, COMMUNITY_WORK_DIRNAME);

  return async function runItem(entry: CommunityStateEntry, signal: AbortSignal): Promise<core.CommunityRunResult> {
    const settings = getSettings();
    await fs.mkdir(workRoot, { recursive: true });
    const workDir = await fs.mkdtemp(path.join(workRoot, `${entry.item.key.replace(/[^\w-]+/g, '-')}-`));
    const reportPath = path.join(workDir, core.COMMUNITY_REPORT_FILENAME);
    const postingPath = path.join(workDir, core.COMMUNITY_POSTING_FILENAME);
    const failed = (error: string): core.CommunityRunResult => ({ report: null, posting: null, error });
    try {
      const { prompt, untrustedItems } = core.buildCommunityRequest({ item: entry.item, skill: settings.skill, reportPath, postingPath });
      await writeUntrustedPayload(workDir, { trust: 'untrusted', source: core.COMMUNITY_UNTRUSTED_SOURCE, fetchedAt: clock.now().toISOString(), items: untrustedItems }, core.MAX_BODY_CHARS);
      await fs.writeFile(path.join(workDir, core.COMMUNITY_PROMPT_FILENAME), prompt);
      return await raceWithAbort<core.CommunityRunResult>({
        timeoutMs: core.RUN_TIMEOUT_SECONDS * 1000,
        onTimeout: () => ({ ...failed(`the research run timed out after ${core.RUN_TIMEOUT_SECONDS}s`), timedOut: true }),
        onEmpty: () => failed('the research run ended without a result'),
        start: async (timeoutSignal) => {
          await spawnSession({
            id: `${core.COMMUNITY_LANE_ID}:${entry.item.key}`,
            name: `Community ${entry.item.key}`,
            cwd: workDir,
            spawnEnv: communitySpawnEnv(),
            extraClaudeArgs: communityClaudeArgs(workDir),
            settingsPermissions: communityAcceptEditsPermissions(),
            signal: AbortSignal.any([signal, timeoutSignal]),
            initialPrompt: core.COMMUNITY_BOOTSTRAP_PROMPT,
          });
          if (signal.aborted || timeoutSignal.aborted) return undefined;
          return { report: await readBoundedFile(reportPath), posting: await readBoundedFile(postingPath), error: null };
        },
      });
    } catch (error) {
      return failed(firstLine(errorMessage(error)) || 'the research run failed');
    } finally {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  };
}

function createDiscordSource(api: PosthogApi, settings: core.CommunitySettings, spawnDependencies: CommunitySpawnDependencies | null, getSaneYoloUnreadablePaths: () => readonly string[]): DiscordSource | null {
  if (!spawnDependencies || settings.discordChannels.length === 0) return null;
  const judgeSpawn = createLaneSpawn({
    laneName: core.COMMUNITY_LANE_ID,
    getSaneYoloUnreadablePaths,
    sessions: spawnDependencies.investigationSessions,
    closeSessionDataClients: spawnDependencies.closeSessionDataClients,
    hookRouter: spawnDependencies.hookRouter,
    getHookPort: spawnDependencies.getHookPort,
    spawnGate: spawnDependencies.spawnGate,
    recordLane: spawnDependencies.recordLane ?? null,
    replayBufferKB: spawnDependencies.replayBufferKB,
    allowTools: COMMUNITY_JUDGE_TOOLS,
  });
  return {
    channels: settings.discordChannels,
    query: (sinceIso) => hogQLRows(api, settings.projectId, core.discordQuery(), { since: sinceIso, channels: settings.discordChannels }),
    judgeQuestions: createCommunityJudge(judgeSpawn),
  };
}

interface CommunityWiringOptions {
  config: GlimmervoidConfig;
  broadcast?: (status: Record<string, unknown>) => void;
  homeDir?: string;
  createApi?: (connection: core.PosthogConnection) => PosthogApi;
  spawnDependencies?: CommunitySpawnDependencies | null;
  controlClientCount?: () => number;
  sendTelegram?: typeof sendTelegramMessage;
  log?: Pick<Console, 'warn'>;
  githubAppToken?: () => string | null;
}

function createCommunityWiring({
  config, broadcast = () => {}, homeDir = glimmervoidHomeDir(),
  createApi = (connection) => createPosthogApi(connection), spawnDependencies = null,
  controlClientCount = () => 0, sendTelegram = sendTelegramMessage, log = console, githubAppToken = () => null,
}: CommunityWiringOptions) {
  const stateIo = createCommunityStateIo(path.join(homeDir, core.COMMUNITY_STATE_FILENAME), log);
  const runItem = spawnDependencies
    ? createCommunityRunner({ spawnDependencies, homeDir, getSettings: () => core.readCommunitySettings(config), hookToolConfig: config, getLaneAccessConfig: () => laneAccessConfigOf(config, githubAppToken()) })
    : undefined;

  function notifyDraftReady(entry: CommunityStateEntry): void {
    const message = core.draftNotificationText(entry);
    broadcast({ type: 'notify', session: entry.item.key, category: core.NOTIFICATION_CATEGORY, message, escalationCount: 0 });
    const { botToken, chatId } = core.readTelegramTarget(config);
    const decision = decideTelegramNotification({
      enabled: config.telegramNotifications === true, botToken, chatId, connectionCount: controlClientCount(),
    });
    if (!decision.send) return;
    void sendTelegram({ botToken, chatId, text: message, tag: core.COMMUNITY_LANE_ID });
  }

  const runner = createLaneRunner({
    tag: core.COMMUNITY_LANE_ID,
    gate: () => core.communityGate(config, process.env, githubAppToken()),
    cfgKey: () => stableConfigKey({ community: config.community ?? null, posthog: core.readPosthogConnection(config), hasReadToken: Boolean(laneAccessConfigOf(config, githubAppToken()).readToken) }),
    emptyStatus: () => ({ ...emptyLaneStatus('community-status', core.communityGate(config, process.env, githubAppToken())), entries: [] }),
    broadcast,
    createPoller: ({ onTickComplete }) => {
      const connection = core.readPosthogConnection(config);
      if (!connection) throw new Error('Community poller started without a PostHog apiKey');
      const settings = core.readCommunitySettings(config);
      const api = createApi(connection);
      return createCommunityPoller({
        intervalMinutes: settings.intervalMinutes,
        queryForum: (sinceIso) => hogQLRows(api, settings.projectId, core.forumQuery(), { since: sinceIso }),
        discord: createDiscordSource(api, settings, spawnDependencies, () => config.saneYoloUnreadablePaths ?? []),
        readState: stateIo.readState,
        writeState: stateIo.writeState,
        runItem,
        onTickComplete,
        onDraftReady: notifyDraftReady,
        firstTickDelayMs: bootStaggerDelay,
        log,
        isCoveredByWatcher,
      });
    },
  });

  const probesChangedListeners = new Set<() => void>();
  const announceProbesMayHaveChanged = () => { for (const listener of probesChangedListeners) listener(); };
  let coveredProbeIds: ReadonlySet<string> = new Set();

  function probes(): Probe[] {
    const connection = core.readPosthogReadConnection(config);
    if (runner.getPoller() === null || connection === null) return [];
    const settings = core.readCommunitySettings(config);
    return communityProbes({ host: connection.host, settings, hasDiscordSource: spawnDependencies !== null && settings.discordChannels.length > 0 });
  }

  function isCoveredByWatcher(): boolean {
    const currentProbes = probes();
    return currentProbes.length > 0 && currentProbes.every((probe) => coveredProbeIds.has(probe.id));
  }

  function coverWithWatcher(coveredProbes: readonly Probe[]): void {
    const wasCovered = isCoveredByWatcher();
    coveredProbeIds = new Set(coveredProbes.map((probe) => probe.id));
    if (!wasCovered && isCoveredByWatcher()) runner.getPoller()?.pollSoon();
  }

  const probeSource = {
    laneId: core.COMMUNITY_LANE_ID, credential: 'posthog' as const, probes,
    onNudge: () => { runner.getPoller()?.pollSoon(); },
    onCoverageChange: coverWithWatcher,
    onWatcherProblem: runner.setWatcherProblem,
  };

  function startPoller(): void {
    runner.startPoller();
    announceProbesMayHaveChanged();
  }

  async function stopPoller(): Promise<void> {
    await runner.stopPoller();
    announceProbesMayHaveChanged();
  }

  function restartIfConfigChanged(): void {
    runner.restartIfConfigChanged();
    announceProbesMayHaveChanged();
  }

  const notRunning = 'The community lane is not running';

  async function submitAction(request: CommunityActionRequest): Promise<Omit<CommunityActionResult, 'key'>> {
    const poller = runner.getPoller();
    if (!poller) return { ok: false, error: notRunning };
    return poller.applyAction(request.key, request.action);
  }

  function sessionPromptFor(key: string): { ok: true; title: string; prompt: string } | { ok: false; error: string } {
    const poller = runner.getPoller();
    if (!poller) return { ok: false, error: notRunning };
    const entry = poller.state().entries[key];
    if (!entry) return { ok: false, error: 'That question is no longer tracked' };
    return { ok: true, title: entry.item.title, prompt: core.communitySessionPrompt(entry) };
  }

  return {
    submitAction,
    sessionPromptFor,
    startPoller,
    stopPoller,
    restartIfConfigChanged,
    getStatus: runner.getStatus,
    getPoller: runner.getPoller,
    probeSource,
    onProbesMayHaveChanged: (listener: () => void) => { probesChangedListeners.add(listener); },
  };
}

export {
  createCommunityStateIo, createCommunityWiring,
};
