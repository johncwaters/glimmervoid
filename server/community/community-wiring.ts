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
import type { GithubAppGrants, LaneAccessConfig } from '../lanes/core/lane-permissions-core.ts';
import * as core from './core/community-core.ts';
import { createCommunityPoller } from './community-poller.ts';
import type { PollSource, SourceFetch } from './community-poller.ts';
import { COMMUNITY_JUDGE_TOOLS, createCommunityJudge } from './community-judge.ts';
import { createLaneSpawn } from '../lanes/lane-spawn.ts';
import type { SessionAccountHome } from '../../session/core/agent-account-core.ts';
import { writeUntrustedPayload } from '../lanes/untrusted-payload.ts';
import { sendTelegramMessage } from '../telegram-transport.ts';
import { decideTelegramNotification } from '../../notifications/channels/telegram.ts';
import { CommunitySourceOutput, CommunityState } from '../../shared/contracts/community.ts';
import type { CommunityActionRequest, CommunityActionResult, CommunitySourceView, CommunityStateEntry } from '../../shared/contracts/community.ts';
import { PACK_DIR_PLACEHOLDER } from '../../shared/contracts/pack.ts';
import type { PackOnDisk } from '../../shared/contracts/pack.ts';
import { createPackCommandRunner } from '../packs/pack-command.ts';
import type { PackCommandSettings } from '../packs/pack-settings.ts';
import { maskSecretsInJson, packCommandRef, packCommunityOf, packIconDataUrl } from '../packs/core/pack-core.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import { errorMessage } from '../../shared/text.ts';
import { TEAM_REVIEW_SESSION_DENY_RULES, createTeamReviewSpawn } from '../github/team-review-spawn.ts';
import { absolutePathReadRule } from '../github/core/team-review-core.ts';
import { ACCEPT_EDITS_MODE, laneAccessConfigFor, laneAccessConfigOf, NO_GITHUB_APP_GRANTS } from '../lanes/core/lane-permissions-core.ts';
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
  accountHomeFor?: ((agentId: string) => SessionAccountHome) | null;
}

function createCommunityRunner({ spawnDependencies, homeDir, getSettings, productOf, hookToolConfig, getLaneAccessConfig }: {
  spawnDependencies: CommunitySpawnDependencies;
  homeDir: string;
  productOf: (sourceId: string) => core.CommunityProduct;
  hookToolConfig: HookToolConfig;
  getLaneAccessConfig: (repositoryFullName: string | null) => LaneAccessConfig;
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
    accountHomeFor: spawnDependencies.accountHomeFor ?? null,
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
      const { prompt, untrustedItems } = core.buildCommunityRequest({ item: entry.item, skill: settings.skill, product: productOf(entry.item.source), reportPath, postingPath });
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
            repository: null,
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

const SOURCE_OUTPUT_MAX_BYTES = 1024 * 1024;

type CommunityPackSource = PollSource & { label: string; docsDomains: readonly string[]; iconDataUrl: string | null; color: CommunitySourceView['color'] };

interface CommunityPacks {
  packsInUse: () => readonly PackOnDisk[];
  commandSettings: (pack: PackOnDisk, commandRef: string) => Promise<PackCommandSettings>;
}

function createPackCommunitySources({ homeDir, packs }: { homeDir: string; packs: CommunityPacks }): () => CommunityPackSource[] {
  const runner = createPackCommandRunner({ homeDir });

  async function fetchFrom(pack: PackOnDisk, source: NonNullable<ReturnType<typeof packCommunityOf>>['sources'][number], sourceId: string, sinceIso: string): Promise<SourceFetch> {
    const settings = await packs.commandSettings(pack, packCommandRef('community-source', source.id));
    if (settings.unreadable !== null) return { ok: false, error: settings.unreadable };
    const argv = source.command.map((word) => word.replaceAll(PACK_DIR_PLACEHOLDER, pack.dir));
    const outcome = await runner.run(argv, { settings, extraEnv: { GLIMMERVOID_SINCE: sinceIso }, timeoutMs: source.timeoutSeconds * 1000, maxBufferBytes: SOURCE_OUTPUT_MAX_BYTES });
    if ('emptyCommand' in outcome) return { ok: false, error: `${source.label}: the command is empty` };
    if (outcome.timedOut) return { ok: false, error: `${source.label} timed out after ${source.timeoutSeconds}s` };
    if (!outcome.run.ok) return { ok: false, error: `${source.label} failed: ${outcome.errorText(outcome.run.stderr) || 'no error output'}` };
    const printed = CommunitySourceOutput.safeParse(maskSecretsInJson(parseJsonOrNull(outcome.run.stdout), settings.secretValues));
    if (!printed.success) return { ok: false, error: `${source.label} printed no valid items JSON: ${printed.error.issues[0]?.message ?? 'unreadable output'}` };
    return { ok: true, ...core.itemsFromSourceOutput(sourceId, printed.data) };
  }

  return () => packs.packsInUse().flatMap((pack) => {
    const community = packCommunityOf(pack);
    if (community === null) return [];
    return community.sources.map((source): CommunityPackSource => {
      const sourceId = `${pack.header.name}:${source.id}`;
      const iconBytes = pack.filesByPath.get(source.icon);
      return {
        id: sourceId, label: source.label, productName: community.product.name, docsDomains: community.product.docsDomains, isJudged: source.judge,
        iconDataUrl: iconBytes === undefined ? null : packIconDataUrl(iconBytes), color: source.color,
        waitingFor: async () => {
          const settings = await packs.commandSettings(pack, packCommandRef('community-source', source.id));
          return settings.unreadable === null ? settings.missingKeys : [];
        },
        fetch: (sinceIso) => fetchFrom(pack, source, sourceId, sinceIso),
      };
    });
  });
}

interface CommunityWiringOptions {
  config: GlimmervoidConfig;
  broadcast?: (status: Record<string, unknown>) => void;
  homeDir?: string;
  packs?: CommunityPacks | null;
  spawnDependencies?: CommunitySpawnDependencies | null;
  controlClientCount?: () => number;
  sendTelegram?: typeof sendTelegramMessage;
  log?: Pick<Console, 'warn'>;
  githubAppGrants?: GithubAppGrants;
}

function createCommunityWiring({
  config, broadcast = () => {}, homeDir = glimmervoidHomeDir(),
  packs = null, spawnDependencies = null,
  controlClientCount = () => 0, sendTelegram = sendTelegramMessage, log = console, githubAppGrants = NO_GITHUB_APP_GRANTS,
}: CommunityWiringOptions) {
  const stateIo = createCommunityStateIo(path.join(homeDir, core.COMMUNITY_STATE_FILENAME), log);
  const packSources = packs === null ? () => [] : createPackCommunitySources({ homeDir, packs });
  const productOf = (sourceId: string): core.CommunityProduct => {
    const source = packSources().find((candidate) => candidate.id === sourceId);
    return { name: source?.productName ?? 'the product', docsDomains: source?.docsDomains ?? [] };
  };
  const laneAccessWithDocs = (repositoryFullName: string | null) => {
    const access = laneAccessConfigFor(config, githubAppGrants, repositoryFullName);
    return { ...access, extraFetchDomains: [...new Set([...access.extraFetchDomains, ...packSources().flatMap((source) => source.docsDomains)])] };
  };
  const runItem = spawnDependencies
    ? createCommunityRunner({ spawnDependencies, homeDir, getSettings: () => core.readCommunitySettings(config), productOf, hookToolConfig: config, getLaneAccessConfig: laneAccessWithDocs })
    : undefined;
  const judgeQuestions = spawnDependencies ? createCommunityJudge(createLaneSpawn({
    laneName: core.COMMUNITY_LANE_ID,
    getSaneYoloUnreadablePaths: () => config.saneYoloUnreadablePaths ?? [],
    sessions: spawnDependencies.investigationSessions,
    closeSessionDataClients: spawnDependencies.closeSessionDataClients,
    hookRouter: spawnDependencies.hookRouter,
    getHookPort: spawnDependencies.getHookPort,
    spawnGate: spawnDependencies.spawnGate,
    recordLane: spawnDependencies.recordLane ?? null,
    replayBufferKB: spawnDependencies.replayBufferKB,
    allowTools: COMMUNITY_JUDGE_TOOLS,
    accountHomeFor: spawnDependencies.accountHomeFor ?? null,
  })) : null;
  const sourceViews = (errorBySource: ReadonlyMap<string, string>, waitingBySource: ReadonlyMap<string, string[]>): CommunitySourceView[] => packSources().map((source) => ({
    id: source.id, label: source.label, iconUrl: source.iconDataUrl, color: source.color, error: errorBySource.get(source.id) ?? null, waitingFor: waitingBySource.get(source.id) ?? [],
  }));

  function notifyDraftReady(entry: CommunityStateEntry): void {
    const message = core.draftNotificationText(entry);
    broadcast({ type: 'notify', session: entry.item.key, category: core.NOTIFICATION_CATEGORY, message, escalationCount: 0 });
    const { botToken, chatId } = core.readTelegramTarget(config);
    const decision = decideTelegramNotification({
      botToken, chatId, connectionCount: controlClientCount(),
    });
    if (!decision.send) return;
    void sendTelegram({ botToken, chatId, text: message, tag: core.COMMUNITY_LANE_ID });
  }

  const runner = createLaneRunner({
    tag: core.COMMUNITY_LANE_ID,
    gate: () => core.communityGate(config, process.env),
    cfgKey: () => stableConfigKey({ community: config.community ?? null, hasReadToken: Boolean(laneAccessConfigOf(config, null).readToken) }),
    emptyStatus: () => ({ ...emptyLaneStatus('community-status', core.communityGate(config, process.env)), entries: [] }),
    broadcast,
    createPoller: ({ onTickComplete }) => {
      const settings = core.readCommunitySettings(config);
      return createCommunityPoller({
        intervalMinutes: settings.intervalMinutes,
        sources: packSources,
        judgeQuestions,
        sourceViews,
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

  function startPoller(): void {
    runner.startPoller();
  }

  function stopPoller(): Promise<void> {
    return runner.stopPoller();
  }

  function restartIfConfigChanged(): void {
    runner.restartIfConfigChanged();
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
  };
}

export {
  createCommunityStateIo, createCommunityWiring,
};
