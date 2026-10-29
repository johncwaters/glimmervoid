import { getAdapter, listAgentIds } from '../../../session/adapters/index.ts';
import type { AgentAdapter } from '../../../session/adapters/index.ts';
import { isGuardedSessionVendor } from '../../../server/guardrails/core/guardrails-roles-core.ts';
import { SETTINGS_INDEX } from '../../../shared/settings/registry-core.ts';
import rootPackage from '../../../package.json';

export interface AgentCard {
  monogram: string;
  label: string;
  support: string;
}

const MONOGRAMS_BY_AGENT_ID: Readonly<Record<string, string>> = { 'claude-code': 'CC', codex: 'CX', grok: 'GK', kimi: 'KM', shell: 'SH' };

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

function minimumNodeVersionOf(enginesRange: string): string {
  const match = /^>=(\d+)\.(\d+)\.\d+$/.exec(enginesRange);
  if (!match) throw new Error(`package.json engines.node ${enginesRange} is not a >=major.minor.patch range`);
  return `${match[1]}.${match[2]}+`;
}

export const AGENT_CARDS: readonly AgentCard[] = builtInAdapters.map((adapter) => ({ monogram: monogramOf(adapter), label: adapter.label, support: supportLevelOf(adapter) }));

export const GUARDED_AGENT_LABELS = labelsOfAdaptersWhere((adapter) => isGuardedSessionVendor(adapter.usageVendor));

export const SANE_YOLO_AGENT_LABELS = labelsOfAdaptersWhere((adapter) => adapter.capabilities.saneYolo);

export const BLOCKED_PATHS_KEY = settingNamed('guardrails.blockedPaths').path.split('.').at(-1);

export const UNREADABLE_PATHS_KEY = settingNamed('guardrails.unreadablePaths').path.split('.').at(-1);

export const DEFAULT_PORT = settingNamed('port').defaultValue;

export const PRODUCT_VERSION = rootPackage.version;

export const REPOSITORY_URL = 'https://github.com/johncwaters/glimmervoid';

export const MINIMUM_NODE_VERSION = minimumNodeVersionOf(rootPackage.engines.node);
