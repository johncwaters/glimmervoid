import { getAdapter, isFirstClassAgent, listAgentIds } from '../../../session/adapters/index.ts';
import type { AgentAdapter } from '../../../session/adapters/index.ts';
import { OPENROUTER_AGENT_IDS } from '../../../shared/contracts/agent-models.ts';
import { SETTINGS_INDEX } from '../../../shared/settings/registry-core.ts';
import rootPackage from '../../../package.json';

export interface AgentCard {
  id: string;
  monogram: string;
  label: string;
  support: string;
}

const MONOGRAMS_BY_AGENT_ID: Readonly<Record<string, string>> = { antigravity: 'AG', 'claude-code': 'CC', codex: 'CX', copilot: 'CP', cursor: 'CU', gemini: 'GM', goose: 'GS', grok: 'GK', kimi: 'KM', opencode: 'OC', pi: 'PI', qwen: 'QW', shell: 'SH' };

const builtInAdapters: AgentAdapter[] = listAgentIds().flatMap((agentId) => {
  const adapter = getAdapter(agentId);
  return adapter ? [adapter] : [];
});

const listJoiner = new Intl.ListFormat('en-GB', { type: 'conjunction' });

function supportLevelOf(adapter: AgentAdapter): string {
  if (isFirstClassAgent(adapter.id)) return 'Full support';
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

export const AGENT_CARDS: readonly AgentCard[] = builtInAdapters.map((adapter) => ({ id: adapter.id, monogram: monogramOf(adapter), label: adapter.label, support: supportLevelOf(adapter) }));

export const OPENROUTER_AGENT_CARDS: readonly AgentCard[] = AGENT_CARDS.filter(({ id }) => OPENROUTER_AGENT_IDS.includes(id));

export const OPENROUTER_AGENT_LABELS = labelsOfAdaptersWhere((adapter) => OPENROUTER_AGENT_IDS.includes(adapter.id));

export const SANE_YOLO_AGENT_LABELS = labelsOfAdaptersWhere((adapter) => adapter.capabilities.saneYolo);

export const UNREADABLE_PATHS_KEY = settingNamed('saneYoloUnreadablePaths').path;

export const DEFAULT_PORT = settingNamed('port').defaultValue;

export const PRODUCT_VERSION = rootPackage.version;

export const REPOSITORY_URL = 'https://github.com/johncwaters/glimmervoid';

export const ACCOUNT_PAGE_URL = 'https://small-wombat-359.convex.site/';

export const SUPPORT_EMAIL = 'support@glimmervoid.dev';

export const ABUSE_EMAIL = 'abuse@glimmervoid.dev';

export const CLOUD_PLAN = { monthlyPriceDollars: 40, includedAwakeHours: 150 } as const;

export const PACK_LIFETIME_MONTHS = 12;

export const AUTHOR = { '@type': 'Person', name: 'John C. Waters', url: 'https://github.com/johncwaters' } as const;

export const CODING_AGENT_LABELS = labelsOfAdaptersWhere((adapter) => adapter.id !== 'shell');

export const PRODUCT_SUMMARY = 'Open-source agentic development environment (ADE) for terminal coding agents. Your agent shows its prototypes, architecture and plans on a whiteboard beside its terminal, each session runs in its own worktree, and you see which one needs you.';

export const HOME_DESCRIPTION = "Open-source ADE for agents. See it before it's built: your coding agent sketches the screen, draws the architecture and shows you on a whiteboard.";
