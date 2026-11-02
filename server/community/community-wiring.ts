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
import { createTeamReviewSpawn } from '../github/team-review-spawn.ts';
import { absolutePathReadRule } from '../github/core/team-review-core.ts';
import { ACCEPT_EDITS_MODE, LANE_CONFIG_EDIT_DENY_RULES, LANE_CREDENTIAL_ENV } from '../lanes/core/lane-permissions-core.ts';
import { firstLine, raceWithAbort } from '../lanes/ephemeral-session.ts';
import type { RecordLane, SpawnGate } from '../lanes/ephemeral-session.ts';
import type { HookRouter } from '../../detection/hook-source.ts';

const COMMUNITY_WORK_DIRNAME = 'community-work';
const RESULT_MAX_BYTES = 1024 * 1024;
const EMPTY_GH_CONFIG_DIRNAME = 'gh-config';
const LINKED_PAGE_TIMEOUT_MS = 10_000;
const COMMUNITY_WEB_TOOLS = Object.freeze(['WebSearch']);
const COMMUNITY_BASH_ALLOW_RULES = Object.freeze([
  'Bash(gh search issues:*)', 'Bash(gh search prs:*)', 'Bash(gh search code:*)', 'Bash(gh issue view:*)', 'Bash(gh pr view:*)',
]);
const COMMUNITY_DENY_RULES = Object.freeze([
  'Bash(gh api:*)', 'Bash(gh auth:*)', 'Bash(env:*)', 'Bash(printenv:*)', 'Bash(echo:*)', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(git push:*)',
  'Bash(gh pr create:*)', 'Bash(gh pr comment:*)', 'Bash(gh pr review:*)', 'Bash(gh issue create:*)', 'Bash(gh issue comment:*)',
  'Edit', 'NotebookEdit', 'WebFetch', ...LANE_CONFIG_EDIT_DENY_RULES,
]);

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

function communityClaudeArgs(workDir: string): string[] {
  const workDirReadRules = ['Read', 'Glob', 'Grep'].map((tool) => absolutePathReadRule(workDir).replace(/^Read/, tool));
  return ['-p', '--allowedTools', ...COMMUNITY_BASH_ALLOW_RULES, ...workDirReadRules, ...COMMUNITY_WEB_TOOLS, '--disallowedTools', ...COMMUNITY_DENY_RULES];
}

function communityAcceptEditsPermissions(): { deny: string[]; defaultMode: string } {
  return { deny: [...COMMUNITY_DENY_RULES], defaultMode: ACCEPT_EDITS_MODE };
}

function communitySpawnEnv(workDir: string): Record<string, string> {
  return {
    ...LANE_CREDENTIAL_ENV,
    GH_CONFIG_DIR: path.join(workDir, EMPTY_GH_CONFIG_DIRNAME),
    GH_PROMPT_DISABLED: '1',
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

async function readCappedText(response: Response, maxBytes: number): Promise<{ text: string; isCutShort: boolean }> {
  if (!response.body) return { text: '', isCutShort: false };
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
    if (totalBytes > maxBytes) {
      await response.body.cancel().catch(() => {});
      return { text: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'), isCutShort: true };
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), isCutShort: false };
}

async function fetchLinkedPage(target: core.LinkedPageTarget, signal: AbortSignal): Promise<core.LinkedPageResult> {
  try {
    const response = await fetch(target.rawUrl, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(LINKED_PAGE_TIMEOUT_MS)]) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { target, failure: `HTTP ${response.status}` };
    }
    const { text, isCutShort } = await readCappedText(response, core.MAX_LINKED_PAGE_BYTES);
    return { target, text, isCutShort };
  } catch (error) {
    return { target, failure: firstLine(errorMessage(error)) || 'the request failed' };
  }
}

async function fetchLinkedPages(item: CommunityStateEntry['item'], signal: AbortSignal) {
  const { fetchable, unfetchableLinks } = core.scanLinkedPages(item.title, item.body);
  const results = await Promise.all(fetchable.map((target) => fetchLinkedPage(target, signal)));
  return core.linkedPageItems(results, unfetchableLinks);
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

function createCommunityRunner({ spawnDependencies, homeDir, getSettings, hookToolConfig }: {
  spawnDependencies: CommunitySpawnDependencies;
  homeDir: string;
  hookToolConfig: HookToolConfig;
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
      await fs.mkdir(path.join(workDir, EMPTY_GH_CONFIG_DIRNAME));
      const linkedPages = await fetchLinkedPages(entry.item, signal);
      const { prompt, untrustedItems } = core.buildCommunityRequest({ item: entry.item, skill: settings.skill, reportPath, postingPath, linkedPages });
      await writeUntrustedPayload(workDir, { trust: 'untrusted', source: core.COMMUNITY_UNTRUSTED_SOURCE, fetchedAt: new Date().toISOString(), items: untrustedItems }, core.MAX_BODY_CHARS);
      await fs.writeFile(path.join(workDir, core.COMMUNITY_PROMPT_FILENAME), prompt);
      return await raceWithAbort<core.CommunityRunResult>({
        timeoutMs: core.RUN_TIMEOUT_SECONDS * 1000,
        onTimeout: () => failed(`the research run timed out after ${core.RUN_TIMEOUT_SECONDS}s`),
        onEmpty: () => failed('the research run ended without a result'),
        start: async (timeoutSignal) => {
          await spawnSession({
            id: `${core.COMMUNITY_LANE_ID}:${entry.item.key}`,
            name: `Community ${entry.item.key}`,
            cwd: workDir,
            spawnEnv: communitySpawnEnv(workDir),
            extraClaudeArgs: communityClaudeArgs(workDir),
            settingsPermissions: communityAcceptEditsPermissions(),
            signal: AbortSignal.any([signal, timeoutSignal]),
            initialPrompt: core.COMMUNITY_BOOTSTRAP_PROMPT,
          });
          if (signal.aborted || timeoutSignal.aborted) return undefined;
          const hasUnreadLinkedPage = linkedPages.some((linkedPage) => linkedPage.kind === 'linked-page-unread');
          return { report: await readBoundedFile(reportPath), posting: await readBoundedFile(postingPath), error: null, hasUnreadLinkedPage };
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
}

function createCommunityWiring({
  config, broadcast = () => {}, homeDir = glimmervoidHomeDir(),
  createApi = (connection) => createPosthogApi(connection), spawnDependencies = null,
  controlClientCount = () => 0, sendTelegram = sendTelegramMessage, log = console,
}: CommunityWiringOptions) {
  const stateIo = createCommunityStateIo(path.join(homeDir, core.COMMUNITY_STATE_FILENAME), log);
  const runItem = spawnDependencies
    ? createCommunityRunner({ spawnDependencies, homeDir, getSettings: () => core.readCommunitySettings(config), hookToolConfig: config })
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
        discord: createDiscordSource(api, settings, spawnDependencies, () => config.saneYoloUnreadablePaths ?? []),
        readState: stateIo.readState,
        writeState: stateIo.writeState,
        runItem,
        onTickComplete,
        onDraftReady: notifyDraftReady,
        firstTickDelayMs: bootStaggerDelay,
        log,
      });
    },
  });

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
    startPoller: runner.startPoller,
    stopPoller: runner.stopPoller,
    restartIfConfigChanged: runner.restartIfConfigChanged,
    getStatus: runner.getStatus,
    getPoller: runner.getPoller,
  };
}

export {
  createCommunityStateIo, createCommunityWiring,
};
