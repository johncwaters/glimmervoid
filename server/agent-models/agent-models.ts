import fs from 'node:fs/promises';

import { execFileAsync } from '../child-process-safe.ts';
import { commandFor, getAdapter } from '../../session/adapters/index.ts';
import kimi from '../../session/adapters/kimi.ts';
import { claudeConfiguredDefault, codexConfiguredDefault, parseAntigravityModels, parseClaudeInitialize, parseCodexModels, parseKimiModels, parseOpenCodeModels, parseOpenRouterModels, parsePiModels } from '../../shared/agent-models-core.ts';
import { CATALOG_AGENT_IDS, NO_PROVIDER_MODELS } from '../../shared/contracts/agent-models.ts';
import path from 'node:path';
import { realAgentHome } from '../../session/agent-home.ts';
import { CLAUDE_HOME_PROFILE, CODEX_HOME_PROFILE } from '../../session/core/agent-home-core.ts';
import type { ConfiguredDefault, AgentModelCatalog, AgentModels, CatalogAgentId, CatalogModel, ProviderModels } from '../../shared/contracts/agent-models.ts';
import { clock } from '../../shared/clock.ts';
import { createCoalescedTimer } from '../../shared/coalesce-timer.ts';
import { existsSync, watch as watchFolder } from 'node:fs';

const CHANGE_DEBOUNCE_MS = 500;
const WINDOWS_COMMAND_EXTENSIONS = ['.exe', '.cmd', '.bat', '.ps1'];
const NOTHING_CONFIGURED: ConfiguredDefault = Object.freeze({ model: null, effort: null });
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const CLAUDE_INITIALIZE_REQUEST = `${JSON.stringify({ type: 'control_request', request_id: 'glimmervoid-models', request: { subtype: 'initialize' } })}\n`;
const CLAUDE_PROBE_ARGS = ['-p', '--setting-sources', '', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
const CODEX_PROBE_ARGS = ['debug', 'models'];
const OPENCODE_PROBE_ARGS = ['models', '--standalone'];
const PI_PROBE_ARGS = ['--list-models', '--offline'];
const ANTIGRAVITY_PROBE_ARGS = ['models'];

type ModelProbe = () => Promise<CatalogModel[] | null>;

async function runAgentCommand(agentId: string, agentArgs: string[], input: string | null): Promise<string> {
  const adapter = getAdapter(agentId);
  if (!adapter) throw new Error(`no adapter for ${agentId}`);
  const command = adapter.buildSpawnCommand({ platform: process.platform, resolved: commandFor(adapter), agentArgs });
  const { stdout } = await execFileAsync(command.file, command.args, {
    encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER_BYTES, windowsHide: true, ...(input === null ? {} : { input }),
  });
  return stdout;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readConfiguredDefault(filePath: string, models: CatalogModel[], parse: (text: string, models: CatalogModel[]) => ConfiguredDefault | undefined): Promise<ConfiguredDefault | undefined> {
  if (models.length === 0) return undefined;
  try {
    return parse(await fs.readFile(filePath, 'utf8'), models);
  } catch (error) {
    return isMissingFileError(error) ? NOTHING_CONFIGURED : undefined;
  }
}

const CONFIGURED_DEFAULT_READERS: Readonly<Partial<Record<CatalogAgentId, (models: CatalogModel[]) => Promise<ConfiguredDefault | undefined>>>> = Object.freeze({
  'claude-code': (models) => readConfiguredDefault(path.join(realAgentHome(CLAUDE_HOME_PROFILE), 'settings.json'), models, claudeConfiguredDefault),
  codex: (models) => readConfiguredDefault(path.join(realAgentHome(CODEX_HOME_PROFILE), 'config.toml'), models, codexConfiguredDefault),
});

const PROBES: Readonly<Record<CatalogAgentId, ModelProbe>> = Object.freeze({
  'claude-code': async () => parseClaudeInitialize(await runAgentCommand('claude-code', CLAUDE_PROBE_ARGS, CLAUDE_INITIALIZE_REQUEST)),
  codex: async () => parseCodexModels(await runAgentCommand('codex', CODEX_PROBE_ARGS, null)),
  kimi: async () => parseKimiModels(await fs.readFile(kimi.configFilePath(), 'utf8')),
  opencode: async () => parseOpenCodeModels(await runAgentCommand('opencode', OPENCODE_PROBE_ARGS, null)),
  pi: async () => parsePiModels(await runAgentCommand('pi', PI_PROBE_ARGS, null)),
  antigravity: async () => parseAntigravityModels(await runAgentCommand('antigravity', ANTIGRAVITY_PROBE_ARGS, null)),
});

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}

async function probedModels(agent: CatalogAgentId): Promise<{ models: CatalogModel[] | null; error: string | null }> {
  try {
    const models = await PROBES[agent]();
    return { models, error: models === null ? 'the agent reported no model list Glimmervoid can read' : null };
  } catch (error) {
    return { models: null, error: firstLine(error) };
  }
}

async function probeAgent(agent: CatalogAgentId, nowMs: number): Promise<AgentModels> {
  const { models, error } = await probedModels(agent);
  const lastGoodModels = lastCatalog.agents.find((previous) => previous.agent === agent)?.models ?? [];
  const listedModels = models ?? lastGoodModels;
  const configuredDefault = await CONFIGURED_DEFAULT_READERS[agent]?.(listedModels);
  return { agent, models: listedModels, ...(configuredDefault ? { configuredDefault } : {}), error, checkedAt: nowMs };
}

async function fetchOpenRouterModels(): Promise<CatalogModel[] | null> {
  const response = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`OpenRouter answered ${response.status} ${response.statusText}`);
  return parseOpenRouterModels(await response.text());
}

async function openRouterModels(previous: ProviderModels, nowMs: number): Promise<ProviderModels> {
  try {
    const models = await fetchOpenRouterModels();
    if (models === null) return { models: previous.models, error: 'OpenRouter sent a model list Glimmervoid cannot read', checkedAt: nowMs };
    return { models, error: null, checkedAt: nowMs };
  } catch (error) {
    return { models: previous.models, error: firstLine(error), checkedAt: nowMs };
  }
}

type ListingState = 'idle' | 'listing' | 'listingThenAgain';
type CatalogSubscriber = { onChange: () => void; log: Pick<Console, 'warn'> };

let lastCatalog: AgentModelCatalog = { agents: CATALOG_AGENT_IDS.map((agent) => ({ agent, models: [], error: null, checkedAt: null })), openrouter: NO_PROVIDER_MODELS };
let probeQueue: Promise<void> = Promise.resolve();
const subscribers = new Set<CatalogSubscriber>();
const listingStateByAgent = new Map<CatalogAgentId, ListingState>();
const stopWatchingByAgent = new Map<CatalogAgentId, () => void>();

function notifySubscribers(): void {
  for (const subscriber of subscribers) subscriber.onChange();
}

function warnSubscribers(message: string): void {
  for (const subscriber of subscribers) subscriber.log.warn(message);
}

function replaceAgentModels(next: AgentModels): void {
  lastCatalog = { ...lastCatalog, agents: lastCatalog.agents.map((current) => (current.agent === next.agent ? next : current)) };
  notifySubscribers();
}

function listAgent(agent: CatalogAgentId): void {
  const state = listingStateByAgent.get(agent) ?? 'idle';
  if (state !== 'idle') {
    listingStateByAgent.set(agent, 'listingThenAgain');
    return;
  }
  listingStateByAgent.set(agent, 'listing');
  probeQueue = probeQueue.then(async () => {
    replaceAgentModels(await probeAgent(agent, clock.nowMs()));
    if (subscribers.size > 0) watchAgent(agent);
    const listedAgain = listingStateByAgent.get(agent) === 'listingThenAgain';
    listingStateByAgent.set(agent, 'idle');
    if (listedAgain) listAgent(agent);
  });
}

async function rereadConfiguredDefault(agent: CatalogAgentId): Promise<void> {
  const current = lastCatalog.agents.find((agentModels) => agentModels.agent === agent);
  const readConfigured = CONFIGURED_DEFAULT_READERS[agent];
  if (!current || !readConfigured || current.models.length === 0) return;
  const configuredDefault = await readConfigured(current.models);
  if (JSON.stringify(configuredDefault) === JSON.stringify(current.configuredDefault)) return;
  const { configuredDefault: _previous, ...withoutDefault } = current;
  replaceAgentModels(configuredDefault ? { ...withoutDefault, configuredDefault } : withoutDefault);
}

function watchFolderFor(folder: string, fileNames: readonly string[], onChange: () => void): () => void {
  const changeTimer = createCoalescedTimer({ mode: 'leading', delayMs: CHANGE_DEBOUNCE_MS, run: onChange });
  try {
    const watcher = watchFolder(folder, { persistent: false }, (_event, changedName) => {
      if (changedName === null || fileNames.includes(changedName)) changeTimer.schedule();
    });
    watcher.on('error', () => {
      warnSubscribers(`[agent-models] stopped watching ${folder}; its agent keeps the models last listed`);
      watcher.close();
    });
    return () => {
      changeTimer.cancel();
      watcher.close();
    };
  } catch {
    warnSubscribers(`[agent-models] cannot watch ${folder}; its agent keeps the models last listed`);
    return () => {};
  }
}

function nearestExistingFolderOf(filePath: string): string {
  let folder = path.dirname(filePath);
  while (!existsSync(folder) && path.dirname(folder) !== folder) folder = path.dirname(folder);
  return folder;
}

function watchPath(filePath: string, onChange: () => void): () => void {
  const folder = nearestExistingFolderOf(filePath);
  if (folder === path.dirname(filePath)) return watchFolderFor(folder, [path.basename(filePath)], onChange);
  const nextSegment = path.relative(folder, filePath).split(path.sep)[0];
  let stopCurrent = watchFolderFor(folder, [nextSegment], () => {
    stopCurrent();
    stopCurrent = watchPath(filePath, onChange);
    onChange();
  });
  return () => stopCurrent();
}

function commandFileNamesOf(commandName: string): string[] {
  if (process.platform !== 'win32') return [commandName];
  return [commandName, ...WINDOWS_COMMAND_EXTENSIONS.map((extension) => `${commandName}${extension}`)];
}

function watchExecutable(agent: CatalogAgentId): () => void {
  const adapter = getAdapter(agent);
  if (!adapter) return () => {};
  const executablePath = commandFor(adapter)?.path ?? null;
  if (executablePath !== null) return watchPath(executablePath, () => listAgent(agent));
  const pathFolders = (process.env.PATH ?? '').split(path.delimiter).filter((folder) => folder !== '' && existsSync(folder));
  const stops = pathFolders.map((folder) => watchFolderFor(folder, commandFileNamesOf(adapter.commandName), () => listAgent(agent)));
  return () => { for (const stop of stops) stop(); };
}

const CONFIG_FILE_WATCHES: Readonly<Partial<Record<CatalogAgentId, () => { filePath: string; onChange: () => void }>>> = Object.freeze({
  'claude-code': () => ({ filePath: path.join(realAgentHome(CLAUDE_HOME_PROFILE), 'settings.json'), onChange: () => { void rereadConfiguredDefault('claude-code'); } }),
  codex: () => ({ filePath: path.join(realAgentHome(CODEX_HOME_PROFILE), 'config.toml'), onChange: () => { void rereadConfiguredDefault('codex'); } }),
  kimi: () => ({ filePath: kimi.configFilePath(), onChange: () => listAgent('kimi') }),
});

function watchAgent(agent: CatalogAgentId): void {
  stopWatchingByAgent.get(agent)?.();
  const stopExecutable = watchExecutable(agent);
  const configFile = CONFIG_FILE_WATCHES[agent]?.();
  const stopConfig = configFile ? watchPath(configFile.filePath, configFile.onChange) : () => {};
  stopWatchingByAgent.set(agent, () => {
    stopExecutable();
    stopConfig();
  });
}

function startCatalog(): void {
  for (const agent of CATALOG_AGENT_IDS) listAgent(agent);
  probeQueue = probeQueue.then(async () => {
    lastCatalog = { ...lastCatalog, openrouter: await openRouterModels(lastCatalog.openrouter, clock.nowMs()) };
    notifySubscribers();
  });
}

function stopCatalog(): void {
  for (const stopWatching of stopWatchingByAgent.values()) stopWatching();
  stopWatchingByAgent.clear();
}

function startAgentModelCatalog(subscriber: CatalogSubscriber): { stop(): void } {
  subscribers.add(subscriber);
  if (subscribers.size === 1) startCatalog();
  return {
    stop() {
      if (!subscribers.delete(subscriber) || subscribers.size > 0) return;
      stopCatalog();
    },
  };
}

function currentAgentModelCatalog(): AgentModelCatalog {
  return lastCatalog;
}

export { currentAgentModelCatalog, startAgentModelCatalog };
