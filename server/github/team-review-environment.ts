import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { cachedAgentResolvability } from '../../session/adapters/index.ts';
import { realKimiHome } from '../../session/kimi-home.ts';
import type { ReviewAgentOffer, ReviewModelOffer, ReviewSkillOffer, TeamReviewEnvironment } from '../../shared/contracts/team-review-environment.ts';
import { codexHomeDir } from '../core/codex-credentials-core.ts';
import * as environmentCore from './core/team-review-environment-core.ts';
import { readTeamReviewSettings } from './core/team-review-core.ts';
import type { TeamReviewSettingsSource } from './core/team-review-core.ts';
import { describeTeamReviewSandbox } from './team-review-wiring.ts';

const SCAN_FRESH_FOR_MS = 60_000;
const SKILL_FILE_NAME = 'SKILL.md';

interface AgentScan { id: ReviewAgentOffer['id']; models: ReviewModelOffer[]; efforts: string[]; skills: ReviewSkillOffer[] }

let lastScan: AgentScan[] = [];
let lastScanStartedAtMs = Number.NEGATIVE_INFINITY;
let scanInFlight: Promise<void> | null = null;

async function readTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function readJsonOrNull(filePath: string): Promise<unknown> {
  const text = await readTextOrNull(filePath);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function scanSkillFolder(skillsFolder: string, source: ReviewSkillOffer['source'], namePrefix = ''): Promise<ReviewSkillOffer[]> {
  const entryNames = await fs.readdir(skillsFolder).catch(() => []);
  const skills: ReviewSkillOffer[] = [];
  for (const entryName of entryNames) {
    const markdown = await readTextOrNull(path.join(skillsFolder, entryName, SKILL_FILE_NAME));
    const frontmatter = markdown === null ? null : environmentCore.parseSkillFrontmatter(markdown);
    if (frontmatter) skills.push({ name: `${namePrefix}${frontmatter.name}`, description: frontmatter.description, source });
  }
  return skills;
}

async function scanClaude(homeDir: string, env: NodeJS.ProcessEnv): Promise<AgentScan> {
  const claudeHome = env.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDir, '.claude');
  const [userSkills, installedPlugins, settings] = await Promise.all([
    scanSkillFolder(path.join(claudeHome, 'skills'), 'user'),
    readJsonOrNull(path.join(claudeHome, 'plugins', 'installed_plugins.json')),
    readJsonOrNull(path.join(claudeHome, 'settings.json')),
  ]);
  const pluginSkills = await Promise.all(environmentCore.enabledClaudePluginInstalls(installedPlugins, settings)
    .map(({ pluginName, installPath }) => scanSkillFolder(path.join(installPath, 'skills'), 'plugin', `${pluginName}:`)));
  return { id: 'claude', models: [...environmentCore.CLAUDE_MODELS], efforts: [...environmentCore.CLAUDE_EFFORTS], skills: [...userSkills, ...pluginSkills.flat()] };
}

async function scanCodex(homeDir: string, env: NodeJS.ProcessEnv): Promise<AgentScan> {
  const codexHome = codexHomeDir(env, homeDir);
  const [catalog, codexSkills, codexSystemSkills, sharedAgentSkills] = await Promise.all([
    readJsonOrNull(path.join(codexHome, 'models_cache.json')),
    scanSkillFolder(path.join(codexHome, 'skills'), 'user'),
    scanSkillFolder(path.join(codexHome, 'skills', '.system'), 'user'),
    scanSkillFolder(path.join(homeDir, '.agents', 'skills'), 'user'),
  ]);
  const models = environmentCore.parseCodexModelCatalog(catalog);
  return { id: 'codex', models, efforts: environmentCore.uniqueEfforts(models), skills: [...codexSkills, ...codexSystemSkills, ...sharedAgentSkills] };
}

async function scanKimi(homeDir: string, env: NodeJS.ProcessEnv): Promise<AgentScan> {
  const kimiHome = realKimiHome(env, homeDir);
  const [configToml, skills] = await Promise.all([
    readTextOrNull(path.join(kimiHome, 'config.toml')),
    scanSkillFolder(path.join(kimiHome, 'skills'), 'user'),
  ]);
  const models = configToml === null ? [] : environmentCore.parseKimiModels(configToml);
  return { id: 'kimi', models, efforts: environmentCore.uniqueEfforts(models), skills };
}

async function scanReviewAgents(homeDir: string, env: NodeJS.ProcessEnv): Promise<void> {
  lastScan = await Promise.all([scanClaude(homeDir, env), scanCodex(homeDir, env), scanKimi(homeDir, env)]);
}

function refreshWhenStale(nowMs: number, homeDir: string, env: NodeJS.ProcessEnv): void {
  if (scanInFlight || nowMs - lastScanStartedAtMs < SCAN_FRESH_FOR_MS) return;
  lastScanStartedAtMs = nowMs;
  scanInFlight = scanReviewAgents(homeDir, env).finally(() => { scanInFlight = null; });
}

function agentOffer(scan: AgentScan): ReviewAgentOffer {
  const { label, resolvable } = cachedAgentResolvability(scan.id);
  return { ...scan, label, installed: resolvable };
}

function currentTeamReviewEnvironment(
  settingsSource: TeamReviewSettingsSource,
  { nowMs = Date.now(), homeDir = os.homedir(), env = process.env }: { nowMs?: number; homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): TeamReviewEnvironment {
  refreshWhenStale(nowMs, homeDir, env);
  return {
    agents: lastScan.map(agentOffer),
    sandbox: describeTeamReviewSandbox(readTeamReviewSettings(settingsSource).sandbox),
  };
}

export { currentTeamReviewEnvironment };
