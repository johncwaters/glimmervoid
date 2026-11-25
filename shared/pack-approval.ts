import type { PackRow } from './contracts/control/pack-messages.ts';
import { isLoopbackHostname } from './loopback-hosts.ts';

const PACK_APPROVAL_HASH_PREFIX = '#pack/';
const PACK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function packApprovalUrl(port: number, packName: string): string {
  return `http://localhost:${port}/${PACK_APPROVAL_HASH_PREFIX}${packName}`;
}

export function packApprovalHashOf(packName: string): string {
  return `${PACK_APPROVAL_HASH_PREFIX}${packName}`;
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

type PackGrantItem = { text: string; detail: string | null; sourceId: string | null };
export type PackGrantSection = { title: string; items: PackGrantItem[] };

function grantItem(text: string, detail: string | null = null, sourceId: string | null = null): PackGrantItem {
  return { text, detail, sourceId };
}

function hostOf(url: string): string {
  return URL.parse(url)?.host ?? url;
}

function namedCommands(row: PackRow): { commandRef: string; name: string }[] {
  const named = [
    ...(row.community?.sources ?? []).map((source) => ({ commandRef: `community-source:${source.id}`, id: source.id, name: `${source.label} source` })),
    ...row.jobs.map((job) => ({ commandRef: `job:${job.id}`, id: job.id, name: `Job ${job.label}` })),
  ];
  const countByName = new Map<string, number>();
  for (const command of named) countByName.set(command.name, (countByName.get(command.name) ?? 0) + 1);
  return named.map((command) => ({ commandRef: command.commandRef, name: (countByName.get(command.name) ?? 0) > 1 ? `${command.name} (${command.id})` : command.name }));
}

function commandName(row: PackRow, commandRef: string): string {
  return namedCommands(row).find((command) => command.commandRef === commandRef)?.name ?? `My PRs command ${commandRef.slice(commandRef.indexOf(':') + 1)}`;
}

function receiversText(row: PackRow, setting: PackRow['settings'][number]): string {
  if (setting.kind === 'text' && setting.commands.length === 0) return 'passed to every command of the pack';
  if (setting.commands.length === 0) return 'passed to no command yet';
  return `passed to ${setting.commands.map((commandRef) => commandName(row, commandRef)).join(' and ')} only`;
}

function runsItems(row: PackRow): PackGrantItem[] {
  const prFlowCommandCount = row.prFlows?.pack?.commands.length ?? 0;
  return [
    ...(row.community?.sources ?? []).map((source) => grantItem(commandName(row, `community-source:${source.id}`), `on every Community poll${source.isJudged ? ', messages judged first' : ''}`, source.id)),
    ...row.jobs.map((job) => grantItem(commandName(row, `job:${job.id}`), `on schedule ${job.schedule}`)),
    ...row.launchers.map((launcher) => grantItem(`Launcher ${launcher.label}`, `starts ${launcher.agent} in ${launcher.project}${launcher.schedule === null ? '' : `, also on schedule ${launcher.schedule}`}`)),
    ...row.hooks.map((hook) => grantItem(`Hook ${hook.id}`, `before ${hook.tools.join(' and ')} tool calls in every session`)),
    ...(prFlowCommandCount === 0 ? [] : [grantItem(plural(prFlowCommandCount, 'My PRs command'), 'when you click them')]),
  ];
}

function webItems(row: PackRow): PackGrantItem[] {
  const docsDomains = row.community?.docsDomains ?? [];
  return [
    ...(docsDomains.length === 0 ? [] : [grantItem(docsDomains.join(', '), `research runs read docs there for ${row.community?.product ?? 'its'} questions`)]),
    ...(row.statusUrls.length === 0 ? [] : [grantItem(row.statusUrls.map(hostOf).join(', '), 'status pages read every five minutes')]),
    ...row.mcpServers.map((server) => grantItem(`MCP server ${server.name}`, `${hostOf(server.url)}, added to every session`)),
  ];
}

function sessionItems(row: PackRow): PackGrantItem[] {
  const skillNames = (row.agent?.skills ?? []).map((skill) => skill.name);
  return [
    ...(row.sessions?.dangerouslySkipPermissions ? [grantItem('Sessions without permission prompts', 'for the sessions it starts')] : []),
    ...(row.agent?.context ? [grantItem(`Context ${row.agent.context.path}`, 'read by every session')] : []),
    ...(skillNames.length === 0 ? [] : [grantItem(`Skills ${skillNames.join(', ')}`, 'followed by every session')]),
  ];
}

function panelDetail(panel: PackRow['panels'][number]): string | null {
  const parts = [...(panel.reads.length === 0 ? [] : [`reads ${panel.reads.join(', ')}`]), ...(panel.acts.length === 0 ? [] : [`acts on ${panel.acts.join(', ')}`])];
  return parts.length === 0 ? null : parts.join('; ');
}

function dashboardItems(row: PackRow): PackGrantItem[] {
  return [
    ...row.panels.map((panel) => grantItem(`Panel ${panel.label}`, panelDetail(panel))),
    ...(row.themes.length === 0 ? [] : [grantItem(plural(row.themes.length, 'theme'))]),
  ];
}

export function packGrantSections(row: PackRow): PackGrantSection[] {
  const secretSettings = row.settings.filter((setting) => setting.kind === 'secret');
  const sections: PackGrantSection[] = [
    { title: 'Runs on this machine', items: runsItems(row) },
    { title: 'Gets from your vault', items: secretSettings.map((setting) => grantItem(`${setting.label} (${setting.key})`, receiversText(row, setting))) },
    { title: 'Reaches the web', items: webItems(row) },
    { title: 'Changes every session', items: sessionItems(row) },
    { title: 'Adds to the dashboard', items: dashboardItems(row) },
    { title: 'Asks you for', items: row.settings.filter((setting) => setting.kind === 'text').map((setting) => grantItem(`${setting.label} (${setting.key})`, receiversText(row, setting))) },
  ];
  return sections.filter((section) => section.items.length > 0);
}

export function packGrantsSentence(row: PackRow): string {
  const sections = packGrantSections(row);
  if (sections.length === 0) return 'it adds nothing yet';
  return sections.map((section) => `${section.title}: ${section.items.map((item) => (item.detail === null ? item.text : `${item.text} (${item.detail})`)).join(', ')}`).join('. ');
}

type PackContents = {
  panels: readonly unknown[];
  launchers: readonly unknown[];
  themes: readonly unknown[];
  agent: { context: unknown; skills: readonly unknown[] } | null;
  mcpServers: readonly unknown[];
  hooks: readonly unknown[];
  prFlows: unknown;
  communitySources: readonly unknown[];
  jobs: readonly unknown[];
  settings: readonly unknown[];
};

export function packKindLabels(row: PackContents): string[] {
  const hasAgentFiles = row.agent !== null && (row.agent.context !== null || row.agent.skills.length > 0);
  return [
    ...(row.panels.length === 0 ? [] : ['Panel']),
    ...(row.launchers.length === 0 ? [] : ['Launcher']),
    ...(row.themes.length === 0 ? [] : [row.themes.length === 1 ? '1 theme' : `${row.themes.length} themes`]),
    ...(hasAgentFiles ? ['Agent skills'] : []),
    ...(row.mcpServers.length === 0 ? [] : ['MCP servers']),
    ...(row.hooks.length === 0 ? [] : ['Hooks']),
    ...(row.prFlows ? ['PR commands'] : []),
    ...(row.communitySources.length === 0 ? [] : ['Community sources']),
    ...(row.jobs.length === 0 ? [] : ['Jobs']),
    ...(row.settings.length === 0 ? [] : ['Settings']),
  ];
}
