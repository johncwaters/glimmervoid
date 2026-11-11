import { getAdapter, listAgentIds } from '../../../session/adapters/index.ts';
import type { AgentAdapter } from '../../../session/adapters/index.ts';
import { SETTINGS_INDEX } from '../../../shared/settings/registry-core.ts';
import rootPackage from '../../../package.json';

export interface AgentCard {
  monogram: string;
  label: string;
  support: string;
}

const MONOGRAMS_BY_AGENT_ID: Readonly<Record<string, string>> = { 'claude-code': 'CC', codex: 'CX', copilot: 'CP', cursor: 'CU', gemini: 'GM', goose: 'GS', grok: 'GK', kimi: 'KM', opencode: 'OC', qwen: 'QW', shell: 'SH' };

const builtInAdapters: AgentAdapter[] = listAgentIds().flatMap((agentId) => {
  const adapter = getAdapter(agentId);
  return adapter ? [adapter] : [];
});

const listJoiner = new Intl.ListFormat('en-GB', { type: 'conjunction' });

function supportLevelOf(adapter: AgentAdapter): string {
  if (Object.values(adapter.capabilities).every(Boolean)) return 'Full support';
  if (adapter.capabilities.hooks) return 'Hook status';
  return 'Title status';
}

function monogramOf(adapter: AgentAdapter): string {
  const monogram = MONOGRAMS_BY_AGENT_ID[adapter.id];
  if (!monogram) throw new Error(`site/src/lib/product-facts.ts has no monogram for the ${adapter.id} agent adapter`);
  return monogram;
}

function labelsOfAdaptersWhere(isIncluded: (adapter: AgentAdapter) => boolean): string {
  return listJoiner.format(builtInAdapters.filter(isIncluded).map((adapter) => adapter.label));
}

function settingNamed(settingPath: string) {
  const setting = SETTINGS_INDEX.byPath.get(settingPath);
  if (!setting) throw new Error(`the settings registry no longer declares ${settingPath}`);
  return setting;
}

export const AGENT_CARDS: readonly AgentCard[] = builtInAdapters.map((adapter) => ({ monogram: monogramOf(adapter), label: adapter.label, support: supportLevelOf(adapter) }));

export const SANE_YOLO_AGENT_LABELS = labelsOfAdaptersWhere((adapter) => adapter.capabilities.saneYolo);

export const UNREADABLE_PATHS_KEY = settingNamed('saneYoloUnreadablePaths').path;

export const DEFAULT_PORT = settingNamed('port').defaultValue;

export const PRODUCT_VERSION = rootPackage.version;

export const REPOSITORY_URL = 'https://github.com/johncwaters/glimmervoid';

export const AUTHOR = { '@type': 'Person', name: 'John C. Waters', url: 'https://github.com/johncwaters' } as const;

export const CODING_AGENT_LABELS = labelsOfAdaptersWhere((adapter) => adapter.id !== 'shell');

export const PRODUCT_SUMMARY = 'Open-source agentic development environment (ADE) for terminal coding agents. Your agent shows its prototypes, architecture and plans on a whiteboard beside its terminal, each session runs in its own worktree, and you see which one needs you.';

export const HOME_DESCRIPTION = 'Open-source orchestrator for Claude Code, Codex and other terminal coding agents: a worktree per session, plans on a whiteboard, and which one needs you.';
