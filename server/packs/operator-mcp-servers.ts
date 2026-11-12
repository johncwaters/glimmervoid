import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KIMI_MCP_CONFIG_NAME } from '../../mcp/core/agent-config.ts';
import codex from '../../session/adapters/codex.ts';
import { realAgentHome } from '../../session/agent-home.ts';
import { KIMI_HOME_PROFILE } from '../../session/core/agent-home-core.ts';
import { execFileAsync } from '../child-process-safe.ts';
import { listClaudeGlobalConfigPathCandidates } from '../core/claude-config-paths-core.ts';
import { parseJsonOrNull } from '../core/json-core.ts';
import type { OperatorMcpServerNames } from './core/pack-core.ts';

const CODEX_MCP_LIST_TIMEOUT_MS = 10000;

async function readTextOrEmpty(filePath: string): Promise<string> {
  return fs.promises.readFile(filePath, 'utf8').catch(() => '');
}

function jsonServerNames(text: string): Set<string> {
  const parsed = parseJsonOrNull(text);
  if (typeof parsed !== 'object' || parsed === null || !('mcpServers' in parsed)) return new Set();
  const servers = parsed.mcpServers;
  return typeof servers === 'object' && servers !== null ? new Set(Object.keys(servers)) : new Set();
}

export async function listCodexMcpServers({ env = process.env, cwd }: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<unknown> {
  const listCommand = codex.buildSpawnCommand({ platform: process.platform, resolved: codex.resolveCommand(), agentArgs: ['mcp', 'list', '--json'] });
  const { stdout } = await execFileAsync(listCommand.file, listCommand.args, { encoding: 'utf8', timeout: CODEX_MCP_LIST_TIMEOUT_MS, windowsHide: true, env, ...(cwd ? { cwd } : {}) });
  return JSON.parse(stdout);
}

function codexServerNamesIn(listed: unknown): Set<string> {
  if (!Array.isArray(listed)) return new Set();
  return new Set(listed.flatMap((server) => (typeof server === 'object' && server !== null && 'name' in server && typeof server.name === 'string' ? [server.name] : [])));
}

export async function readCodexOperatorServerNames(env: NodeJS.ProcessEnv, cwd?: string): Promise<Set<string>> {
  return codexServerNamesIn(await listCodexMcpServers({ env, ...(cwd ? { cwd } : {}) }).catch(() => null));
}

export async function readOperatorMcpServerNames(env: NodeJS.ProcessEnv): Promise<OperatorMcpServerNames> {
  const [, claudeConfigPath] = listClaudeGlobalConfigPathCandidates(env, os.homedir());
  const [claudeText, codexNames, kimiText] = await Promise.all([
    readTextOrEmpty(claudeConfigPath),
    readCodexOperatorServerNames(env),
    readTextOrEmpty(path.join(realAgentHome(KIMI_HOME_PROFILE, env), KIMI_MCP_CONFIG_NAME)),
  ]);
  return { 'claude-code': jsonServerNames(claudeText), codex: codexNames, kimi: jsonServerNames(kimiText) };
}
