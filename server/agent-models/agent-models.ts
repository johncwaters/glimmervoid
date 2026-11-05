import fs from 'node:fs/promises';

import { execFileAsync } from '../child-process-safe.ts';
import { commandFor, getAdapter } from '../../session/adapters/index.ts';
import kimi from '../../session/adapters/kimi.ts';
import { parseClaudeInitialize, parseCodexModels, parseKimiModels } from '../../shared/agent-models-core.ts';
import { CATALOG_AGENT_IDS } from '../../shared/contracts/agent-models.ts';
import type { AgentModelCatalog, AgentModels, CatalogAgentId, CatalogModel } from '../../shared/contracts/agent-models.ts';

const SCAN_FRESH_FOR_MS = 60_000;
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const CLAUDE_INITIALIZE_REQUEST = `${JSON.stringify({ type: 'control_request', request_id: 'glimmervoid-models', request: { subtype: 'initialize' } })}\n`;
const CLAUDE_PROBE_ARGS = ['-p', '--setting-sources', '', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
const CODEX_PROBE_ARGS = ['debug', 'models'];

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

const PROBES: Readonly<Record<CatalogAgentId, ModelProbe>> = Object.freeze({
  'claude-code': async () => parseClaudeInitialize(await runAgentCommand('claude-code', CLAUDE_PROBE_ARGS, CLAUDE_INITIALIZE_REQUEST)),
  codex: async () => parseCodexModels(await runAgentCommand('codex', CODEX_PROBE_ARGS, null)),
  kimi: async () => parseKimiModels(await fs.readFile(kimi.configFilePath(), 'utf8')),
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
  return { agent, models: models ?? lastGoodModels, error, checkedAt: nowMs };
}

let lastCatalog: AgentModelCatalog = { agents: CATALOG_AGENT_IDS.map((agent) => ({ agent, models: [], error: null, checkedAt: null })) };
let lastScanStartedAtMs = Number.NEGATIVE_INFINITY;
let scanInFlight: Promise<void> | null = null;

async function scanAgentModels(nowMs: number): Promise<void> {
  const agents: AgentModels[] = [];
  for (const agent of CATALOG_AGENT_IDS) agents.push(await probeAgent(agent, nowMs));
  lastCatalog = { agents };
}

function refreshAgentModelsWhenStale(nowMs = Date.now()): Promise<void> {
  if (scanInFlight) return scanInFlight;
  if (nowMs - lastScanStartedAtMs < SCAN_FRESH_FOR_MS) return Promise.resolve();
  lastScanStartedAtMs = nowMs;
  scanInFlight = new Promise<void>((resolve) => { setImmediate(resolve); }).then(() => scanAgentModels(nowMs)).finally(() => { scanInFlight = null; });
  return scanInFlight;
}

function currentAgentModelCatalog(nowMs = Date.now()): AgentModelCatalog {
  void refreshAgentModelsWhenStale(nowMs);
  return lastCatalog;
}

export { currentAgentModelCatalog };
