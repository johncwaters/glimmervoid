import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isRecord } from '../../shared/coerce.ts';
import { knownWriteHookInput } from '../../session/core/posthog-read-gate-core.ts';
import { execFileAsync } from '../child-process-safe.ts';
import { listClaudeGlobalConfigPathCandidates } from '../core/claude-trust-core.ts';
import { makeHostScratchDirectory } from '../host-scratch.ts';
import { writeJsonAtomic } from '../json-file.ts';
import { relayPath } from '../runtime-paths.ts';
import codex from '../../session/adapters/codex.ts';
import type { ScratchAgentHome } from '../../session/adapters/index.ts';
import { realAgentHome } from '../../session/agent-home.ts';
import { KIMI_HOME_PROFILE } from '../../session/core/agent-home-core.ts';
import { HOOK_TOOLS } from '../../session/core/hook-tools.ts';
import type { ResolvedHookTool } from '../../session/core/hook-tools.ts';
import { codexLaneMcpPosture, codexMcpServers, findPosthogServer, kimiLaneMcpPosture, laneMcpConfig, laneMcpPosture } from './core/lane-permissions-core.ts';
import type { LaneMcpPosture } from './core/lane-permissions-core.ts';

const LANE_MCP_DIR_PREFIX = 'glimmervoid-lane-settings-';
const GATE_SELF_TEST_TIMEOUT_MS = 5000;
const CODEX_MCP_LIST_TIMEOUT_MS = 10000;
const CODEX_AGENT_ID = 'codex';
const KIMI_AGENT_ID = 'kimi';
const DEFAULT_AGENT_ID = 'claude';
const HOOK_SHELL = '/bin/sh';
const BLOCKING_EXIT_CODE = 2;

interface PreparedLaneMcp {
  posture: LaneMcpPosture;
  scratchAgentHome?: ScratchAgentHome;
  cleanup(): Promise<void>;
}

interface LaneMcpDeps {
  readClaudeConfig?: () => Promise<unknown>;
  listCodexServers?: () => Promise<unknown>;
  kimiHome?: string;
  gatePath?: string;
}

async function readOperatorClaudeConfig(): Promise<unknown> {
  const [, currentConfigPath] = listClaudeGlobalConfigPathCandidates(process.env, os.homedir());
  return JSON.parse(await fsPromises.readFile(currentConfigPath, 'utf8'));
}

async function listOperatorCodexServers(): Promise<unknown> {
  const listCommand = codex.buildSpawnCommand({ platform: process.platform, resolved: codex.resolveCommand(), agentArgs: ['mcp', 'list', '--json'] });
  const { stdout } = await execFileAsync(listCommand.file, listCommand.args, { encoding: 'utf8', timeout: CODEX_MCP_LIST_TIMEOUT_MS, windowsHide: true });
  return JSON.parse(stdout);
}

async function gateDeniesKnownWrite(gateTool: ResolvedHookTool): Promise<boolean> {
  const hookCommand = HOOK_TOOLS.posthogReadGate.claudeEntry(gateTool, '').hooks[0]?.command ?? '';
  try {
    await execFileAsync(HOOK_SHELL, ['-c', hookCommand], { input: knownWriteHookInput(gateTool.serverName ?? ''), encoding: 'utf8', timeout: GATE_SELF_TEST_TIMEOUT_MS });
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === BLOCKING_EXIT_CODE;
  }
}

async function prepareCodexLaneMcp(listCodexServers: () => Promise<unknown>, gatePath: string): Promise<PreparedLaneMcp | null> {
  const servers = codexMcpServers(await listCodexServers().catch(() => null));
  const server = findPosthogServer(servers);
  if (!server) return null;
  const otherServerNames = Object.keys(servers).filter((name) => name !== server.name);
  const posture = codexLaneMcpPosture({ server, otherServerNames, gatePath, interpreterPath: process.execPath });
  if (!posture || !(await gateDeniesKnownWrite(posture.hookTool))) return null;
  return { posture, cleanup: async () => {} };
}

async function prepareKimiLaneMcp(kimiHome: string, gatePath: string): Promise<PreparedLaneMcp | null> {
  const kimiMcpConfig = await fsPromises.readFile(path.join(kimiHome, 'mcp.json'), 'utf8').then(JSON.parse, () => null);
  const server = findPosthogServer(isRecord(kimiMcpConfig) ? kimiMcpConfig.mcpServers : null);
  if (!server) return null;
  const posture = kimiLaneMcpPosture({ server, gatePath, interpreterPath: process.execPath });
  if (!posture?.laneHome || !(await gateDeniesKnownWrite(posture.hookTool))) return null;
  const homeParent = await makeHostScratchDirectory(LANE_MCP_DIR_PREFIX);
  return {
    posture,
    scratchAgentHome: { home: path.join(homeParent, 'home'), ...posture.laneHome },
    cleanup: () => fsPromises.rm(homeParent, { recursive: true, force: true }).catch(() => {}),
  };
}

async function prepareLaneMcp(
  { laneArgs, agent }: { laneArgs: readonly string[]; agent?: string },
  { readClaudeConfig = readOperatorClaudeConfig, listCodexServers = listOperatorCodexServers, kimiHome = realAgentHome(KIMI_HOME_PROFILE), gatePath = relayPath('posthog-read-gate') }: LaneMcpDeps = {},
): Promise<PreparedLaneMcp | null> {
  if (agent === CODEX_AGENT_ID) return prepareCodexLaneMcp(listCodexServers, gatePath);
  if (agent === KIMI_AGENT_ID) return prepareKimiLaneMcp(kimiHome, gatePath);
  if (agent !== undefined && agent !== DEFAULT_AGENT_ID) return null;
  const claudeConfig = await readClaudeConfig().catch(() => null);
  const server = findPosthogServer(isRecord(claudeConfig) ? claudeConfig.mcpServers : null);
  if (!server) return null;
  const configDirectory = await makeHostScratchDirectory(LANE_MCP_DIR_PREFIX);
  const removeConfigDirectory = () => fsPromises.rm(configDirectory, { recursive: true, force: true }).catch(() => {});
  const mcpConfigPath = path.join(configDirectory, 'mcp.json');
  try {
    await writeJsonAtomic(mcpConfigPath, laneMcpConfig(server), { mode: 0o600 });
  } catch {
    await removeConfigDirectory();
    return null;
  }
  const posture = laneMcpPosture({ server, mcpConfigPath, gatePath, interpreterPath: process.execPath, laneArgs });
  if (!posture || !(await gateDeniesKnownWrite(posture.hookTool))) {
    await removeConfigDirectory();
    return null;
  }
  return { posture, cleanup: removeConfigDirectory };
}

export { prepareLaneMcp };
