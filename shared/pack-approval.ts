import type { PackRow } from './contracts/control/pack-messages.ts';
import { isLoopbackHostname } from './loopback-hosts.ts';

const PACK_APPROVAL_HASH_PREFIX = '#pack/';
const PACK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function packApprovalUrl(port: number, packName: string): string {
  return `http://localhost:${port}/${PACK_APPROVAL_HASH_PREFIX}${packName}`;
}

export function packNameOfApprovalHash(hash: string): string | null {
  if (!hash.startsWith(PACK_APPROVAL_HASH_PREFIX)) return null;
  const packName = hash.slice(PACK_APPROVAL_HASH_PREFIX.length);
  return PACK_NAME_PATTERN.test(packName) ? packName : null;
}

export function packNameOfApprovalUrl(url: string, dashboardHost: string): string | null {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;
  const dashboard = URL.parse(`http://${dashboardHost}`);
  const isLoopbackOnDashboardPort = dashboard !== null && isLoopbackHostname(parsed.hostname) && parsed.port === dashboard.port;
  const isThisDashboard = parsed.host === dashboardHost || isLoopbackOnDashboardPort;
  if (!isThisDashboard || parsed.pathname !== '/') return null;
  return packNameOfApprovalHash(parsed.hash);
}

export function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function packGrants(row: PackRow): string[] {
  const prFlowCommandCount = row.prFlows?.pack?.commands.length ?? 0;
  const skillNames = (row.agent?.skills ?? []).map((skill) => skill.name);
  return [
    ...row.panels.map((panel) => `panel ${panel.label}${panel.reads.length === 0 ? '' : ` reading ${panel.reads.join(', ')}`}${panel.acts.length === 0 ? '' : ` acting on ${panel.acts.join(', ')}`}`),
    ...(row.themes.length === 0 ? [] : [plural(row.themes.length, 'theme')]),
    ...row.launchers.map((launcher) => `launcher ${launcher.label} starting ${launcher.agent} in ${launcher.project}${launcher.schedule === null ? '' : ` on schedule ${launcher.schedule}`}`),
    ...(row.sessions?.dangerouslySkipPermissions ? ['sessions without permission prompts'] : []),
    ...(row.statusUrls.length === 0 ? [] : [`status pages ${row.statusUrls.join(', ')}`]),
    ...(row.agent?.context ? [`context ${row.agent.context.path} for every session`] : []),
    ...(skillNames.length === 0 ? [] : [`skills ${skillNames.join(', ')} for every session`]),
    ...(prFlowCommandCount === 0 ? [] : [plural(prFlowCommandCount, 'My PRs command')]),
  ];
}

type PackContents = {
  panels: readonly unknown[];
  launchers: readonly unknown[];
  themes: readonly unknown[];
  agent: { context: unknown; skills: readonly unknown[] } | null;
  prFlows: unknown;
};

export function packKindLabels(row: PackContents): string[] {
  const hasAgentFiles = row.agent !== null && (row.agent.context !== null || row.agent.skills.length > 0);
  return [
    ...(row.panels.length === 0 ? [] : ['Panel']),
    ...(row.launchers.length === 0 ? [] : ['Launcher']),
    ...(row.themes.length === 0 ? [] : [row.themes.length === 1 ? '1 theme' : `${row.themes.length} themes`]),
    ...(hasAgentFiles ? ['Agent skills'] : []),
    ...(row.prFlows ? ['PR commands'] : []),
  ];
}
