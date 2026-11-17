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

const SCAN_FRESH_FOR_MS = 60_000;
const OPENROUTER_FRESH_FOR_MS = 60 * 60_000;
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

async function readConfiguredDefault(filePath: string, models: CatalogModel[], parse: (text: string, models: CatalogModel[]) => ConfiguredDefault): Promise<ConfiguredDefault | undefined> {
  try {
    return parse(await fs.readFile(filePath, 'utf8'), models);
  } catch {
    return undefined;
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
  if (previous.checkedAt !== null && previous.error === null && nowMs - previous.checkedAt < OPENROUTER_FRESH_FOR_MS) return previous;
  try {
    const models = await fetchOpenRouterModels();
    if (models === null) return { models: previous.models, error: 'OpenRouter sent a model list Glimmervoid cannot read', checkedAt: nowMs };
    return { models, error: null, checkedAt: nowMs };
  } catch (error) {
    return { models: previous.models, error: firstLine(error), checkedAt: nowMs };
  }
}

let lastCatalog: AgentModelCatalog = { agents: CATALOG_AGENT_IDS.map((agent) => ({ agent, models: [], error: null, checkedAt: null })), openrouter: NO_PROVIDER_MODELS };
let lastScanStartedAtMs = Number.NEGATIVE_INFINITY;
let scanInFlight: Promise<void> | null = null;

async function scanAgentModels(nowMs: number): Promise<void> {
  const agents: AgentModels[] = [];
  for (const agent of CATALOG_AGENT_IDS) agents.push(await probeAgent(agent, nowMs));
  lastCatalog = { agents, openrouter: await openRouterModels(lastCatalog.openrouter, nowMs) };
}

function refreshAgentModelsWhenStale(nowMs = clock.nowMs()): Promise<void> {
  if (scanInFlight) return scanInFlight;
  if (nowMs - lastScanStartedAtMs < SCAN_FRESH_FOR_MS) return Promise.resolve();
  lastScanStartedAtMs = nowMs;
  scanInFlight = new Promise<void>((resolve) => { setImmediate(resolve); }).then(() => scanAgentModels(nowMs)).finally(() => { scanInFlight = null; });
  return scanInFlight;
}

function currentAgentModelCatalog(nowMs = clock.nowMs()): AgentModelCatalog {
  void refreshAgentModelsWhenStale(nowMs);
  return lastCatalog;
}

export { currentAgentModelCatalog };
