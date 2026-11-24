import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { cachedAgentResolvability } from '../../session/adapters/index.ts';
import { currentAgentModelCatalog } from '../agent-models/agent-models.ts';
import type { ReviewAgentOffer, ReviewSkillOffer, TeamReviewEnvironment } from '../../shared/contracts/team-review-environment.ts';
import * as environmentCore from './core/team-review-environment-core.ts';
import { parseSkillFrontmatter } from '../../shared/skill-frontmatter-core.ts';
import { watchPath, watchTree } from '../path-watch.ts';
import type { StopWatching } from '../path-watch.ts';

const SKILL_FILE_NAME = 'SKILL.md';
const IGNORED_SKILL_FOLDER_NAMES: ReadonlySet<string> = new Set(['node_modules', '.git']);

interface AgentScan { id: ReviewAgentOffer['id']; skills: ReviewSkillOffer[] }

interface FollowedClaudeHome {
  claudeHome: string;
  stopFileWatches: StopWatching;
  stopPluginWatches: StopWatching;
  watchedPluginSkillFolders: string;
}

let lastScan: AgentScan[] = [];
let scanChain: Promise<void> = Promise.resolve();
let followed: FollowedClaudeHome | null = null;
const changeListeners = new Set<() => void>();

function teamReviewScanSettled(): Promise<void> {
  return scanChain;
}

function stopFollowing(): void {
  followed?.stopFileWatches();
  followed?.stopPluginWatches();
  followed = null;
}

function onTeamReviewEnvironmentChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
    if (changeListeners.size === 0) stopFollowing();
  };
}

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
    const frontmatter = markdown === null ? null : parseSkillFrontmatter(markdown);
    if (frontmatter) skills.push({ name: `${namePrefix}${frontmatter.name}`, description: frontmatter.description, source });
  }
  return skills;
}

function claudeHomeOf(homeDir: string, env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDir, '.claude');
}

async function scanClaude(claudeHome: string): Promise<{ scan: AgentScan; pluginSkillFolders: string[] }> {
  const [userSkills, installedPlugins, settings] = await Promise.all([
    scanSkillFolder(path.join(claudeHome, 'skills'), 'user'),
    readJsonOrNull(path.join(claudeHome, 'plugins', 'installed_plugins.json')),
    readJsonOrNull(path.join(claudeHome, 'settings.json')),
  ]);
  const pluginInstalls = environmentCore.enabledClaudePluginInstalls(installedPlugins, settings);
  const pluginSkills = await Promise.all(pluginInstalls.map(({ pluginName, installPath }) => scanSkillFolder(path.join(installPath, 'skills'), 'plugin', `${pluginName}:`)));
  return {
    scan: { id: 'claude', skills: [...userSkills, ...pluginSkills.flat()] },
    pluginSkillFolders: pluginInstalls.map(({ installPath }) => path.join(installPath, 'skills')),
  };
}

function isIgnoredSkillFolder(relativePath: string): boolean {
  return IGNORED_SKILL_FOLDER_NAMES.has(path.posix.basename(relativePath));
}

function watchSkillFolder(skillsFolder: string, onChange: () => void): StopWatching {
  return watchTree(skillsFolder, onChange, { isIgnored: isIgnoredSkillFolder });
}

function watchPluginSkillFolders(target: FollowedClaudeHome, pluginSkillFolders: readonly string[]): void {
  const folderKey = JSON.stringify(pluginSkillFolders);
  if (folderKey === target.watchedPluginSkillFolders) return;
  target.stopPluginWatches();
  const stops = pluginSkillFolders.map((skillsFolder) => watchSkillFolder(skillsFolder, () => queueScan(target)));
  target.stopPluginWatches = () => { for (const stop of stops) stop(); };
  target.watchedPluginSkillFolders = folderKey;
}

async function scanReviewAgents(target: FollowedClaudeHome): Promise<void> {
  const previousScan = JSON.stringify(lastScan);
  const { scan, pluginSkillFolders } = await scanClaude(target.claudeHome);
  if (followed !== target) return;
  lastScan = [scan];
  watchPluginSkillFolders(target, pluginSkillFolders);
  if (JSON.stringify(lastScan) === previousScan) return;
  for (const listener of changeListeners) listener();
}

function queueScan(target: FollowedClaudeHome): void {
  scanChain = scanChain.then(() => scanReviewAgents(target)).catch(() => {});
}

function follow(claudeHome: string): void {
  if (followed?.claudeHome === claudeHome) return;
  stopFollowing();
  const target: FollowedClaudeHome = { claudeHome, stopFileWatches: () => {}, stopPluginWatches: () => {}, watchedPluginSkillFolders: '[]' };
  followed = target;
  const onChange = () => queueScan(target);
  const stops = [
    watchSkillFolder(path.join(claudeHome, 'skills'), onChange),
    watchPath(path.join(claudeHome, 'settings.json'), onChange),
    watchPath(path.join(claudeHome, 'plugins', 'installed_plugins.json'), onChange),
  ];
  target.stopFileWatches = () => { for (const stop of stops) stop(); };
  queueScan(target);
}

function agentOffer(scan: AgentScan): ReviewAgentOffer {
  const { label, resolvable } = cachedAgentResolvability(scan.id);
  const claudeModels = currentAgentModelCatalog().agents.find((agentModels) => agentModels.agent === 'claude-code')?.models ?? [];
  return { ...scan, ...environmentCore.reviewModelOffers(claudeModels), label, installed: resolvable };
}

function currentTeamReviewEnvironment(
  { homeDir = os.homedir(), env = process.env }: { homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): TeamReviewEnvironment {
  follow(claudeHomeOf(homeDir, env));
  return {
    agents: lastScan.map(agentOffer),
  };
}

export { currentTeamReviewEnvironment, onTeamReviewEnvironmentChanged, teamReviewScanSettled };
