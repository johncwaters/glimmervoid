import path from 'node:path';
import type { PackRow, PackSourceRow, PacksStatus, PackThemeSwatch } from '../../../shared/contracts/control/pack-messages.ts';
import type { ThemePalette } from '../../../shared/contracts/theme-palette.ts';
import { PACK_SECTION_NAMES, packSkillNameOf } from '../../../shared/contracts/pack.ts';
import { settingReachesCommand } from '../../../shared/contracts/pack-bridge.ts';
import { packKindLabels } from '../../../shared/pack-approval.ts';
import type { z } from 'zod';
import { PackAgent, PackCommunity, PackHooks, PackJobs, PackLaunchers, PackMcp, PackPrFlows, PackSettings, PackUi } from '../../../shared/contracts/pack.ts';
import type { PackCommandKind, PackHeader, PackHook, PackLauncher, PackMcpLaunch, PackMcpServer, PackOnDisk, PackJob, PackPrFlows as PackPrFlowsSection, PackSessions, PackSetting } from '../../../shared/contracts/pack.ts';
import { packSecretEnvName, rendersPackServers } from '../../../mcp/core/agent-config.ts';
import type { PackAgentContribution, PackAgentSkill } from '../../../session/core/pack-session-core.ts';
import { packApproval, prFlowsPacksOf } from '../../github/core/pr-flows-core.ts';
import type { PackRead } from '../pack-files.ts';

function packNeeds(pack: PackOnDisk): string[] {
  return [...pack.header.requires.env.map((name) => `env ${name}`), ...pack.header.requires.programs.map((program) => `program ${program}`)];
}

function packThemes(pack: PackOnDisk): PackUi['themes'] {
  return pack.ui?.ok ? pack.ui.value.themes : [];
}

export function approvedPackThemes(packs: readonly PackOnDisk[]): PacksStatus['themes'] {
  return packs.flatMap((pack) => packThemes(pack).map(({ id, ...palette }) => ({ id: `${pack.header.name}/${id}`, palette })));
}

function packPanels(pack: PackOnDisk): PackUi['panels'] {
  return pack.ui?.ok ? pack.ui.value.panels : [];
}

type FramePathOf = (innerPath: string) => string | null;

function packFileUrl(pack: PackOnDisk, filePath: string, framePathOf: FramePathOf): string | null {
  return framePathOf(`packs/${pack.header.name}/${pack.fingerprint}/${filePath}`);
}

export function approvedPackPanels(packs: readonly PackOnDisk[], framePathOf: FramePathOf): PacksStatus['panels'] {
  return packs.flatMap((pack) => packPanels(pack).flatMap((panel) => {
    const entryUrl = packFileUrl(pack, panel.entry, framePathOf);
    if (entryUrl === null) return [];
    return [{
      viewId: `pack:${pack.header.name}/${panel.id}`, id: panel.id, pack: pack.header.name, label: panel.label, entryUrl,
      iconUrl: panel.icon ? packFileUrl(pack, panel.icon, framePathOf) : null, reads: panel.reads, acts: panel.acts,
    }];
  }));
}

const PACK_FILE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.avif': 'image/avif', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.csv': 'text/csv; charset=utf-8', '.wasm': 'application/wasm',
};

export const PACK_PANEL_CONTENT_POLICY = [
  'sandbox allow-scripts allow-forms',
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
].join('; ');

export function packFileMime(filePath: string): string {
  return PACK_FILE_MIME_BY_EXTENSION[path.posix.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

const OPAQUE_ORIGIN = 'null';

export function packFileHeaders(filePath: string, requestOrigin: string | undefined): Record<string, string> {
  const headers = { 'Content-Security-Policy': PACK_PANEL_CONTENT_POLICY, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Type': packFileMime(filePath), Vary: 'Origin' };
  return requestOrigin === OPAQUE_ORIGIN ? { ...headers, 'Access-Control-Allow-Origin': OPAQUE_ORIGIN } : headers;
}

export function packSectionErrors(pack: PackOnDisk): string[] {
  return PACK_SECTION_NAMES.filter((name) => name !== 'prFlows').flatMap((name) => {
    const section = pack[name];
    return section && !section.ok ? section.errors : [];
  });
}

function packLaunchers(pack: PackOnDisk): PackLauncher[] {
  return pack.launchers?.ok ? pack.launchers.value : [];
}

function packSessionSettings(pack: PackOnDisk): PackSessions | null {
  return pack.sessions?.ok ? pack.sessions.value : null;
}

export type LauncherProjectResolution = { ok: true; path: string } | { ok: false; reason: string };

export function approvedPackLaunchers(packs: readonly PackOnDisk[], resolveProject: (project: string) => LauncherProjectResolution): PacksStatus['launchers'] {
  return packs.flatMap((pack) => packLaunchers(pack).map((launcher) => {
    const resolution = resolveProject(launcher.project);
    return {
      pack: pack.header.name, id: launcher.id, label: launcher.label, agent: launcher.agent, model: launcher.model ?? null, effort: launcher.effort ?? null,
      project: launcher.project, disabledReason: resolution.ok ? null : resolution.reason,
    };
  }));
}

export function approvedLauncher(packs: readonly PackOnDisk[], packName: string, launcherId: string): { launcher: PackLauncher; sessions: PackSessions | null } | null {
  const pack = packs.find((candidate) => candidate.header.name === packName);
  const launcher = pack ? packLaunchers(pack).find((candidate) => candidate.id === launcherId) : undefined;
  if (!pack || !launcher) return null;
  return { launcher, sessions: packSessionSettings(pack) };
}

export function approvedPanel(packs: readonly PackOnDisk[], packName: string, panelId: string): { panel: PackUi['panels'][number]; sessions: PackSessions | null } | null {
  const pack = packs.find((candidate) => candidate.header.name === packName);
  const panel = pack ? packPanels(pack).find((candidate) => candidate.id === panelId) : undefined;
  if (!pack || !panel) return null;
  return { panel, sessions: packSessionSettings(pack) };
}

export type ScheduledPackLauncher = { kind: 'launcher'; pack: string; launcher: PackLauncher; schedule: string };
export type ScheduledPackJob = { kind: 'job'; pack: string; job: PackJob; schedule: string; packDir: string };
export type ScheduledPackEntry = ScheduledPackLauncher | ScheduledPackJob;

function packJobsOf(pack: PackOnDisk): PackJob[] {
  return pack.jobs?.ok === true ? pack.jobs.value : [];
}

export function scheduledEntries(packs: readonly PackOnDisk[]): ScheduledPackEntry[] {
  return packs.flatMap((pack) => [
    ...packLaunchers(pack).flatMap((launcher): ScheduledPackEntry[] => (launcher.schedule ? [{ kind: 'launcher', pack: pack.header.name, launcher, schedule: launcher.schedule }] : [])),
    ...packJobsOf(pack).map((job): ScheduledPackEntry => ({ kind: 'job', pack: pack.header.name, job, schedule: job.schedule, packDir: pack.dir })),
  ]);
}

function packStatusUrls(pack: PackOnDisk): string[] {
  return pack.status?.ok ? pack.status.value.urls : [];
}

export function statusUrlsOf(packs: readonly PackOnDisk[]): string[] {
  return [...new Set(packs.flatMap(packStatusUrls))];
}

export function launcherProjects(packs: readonly PackOnDisk[]): string[] {
  return [...new Set(packs.flatMap((pack) => packLaunchers(pack).map((launcher) => launcher.project)))];
}

function packHooksOf(pack: PackOnDisk): PackHook[] {
  return pack.hooks?.ok ? pack.hooks.value : [];
}

function packAgentSection(pack: PackOnDisk): PackAgent | null {
  return pack.agent?.ok ? pack.agent.value : null;
}

function packFileText(pack: PackOnDisk, filePath: string): string {
  return pack.filesByPath.get(filePath)?.toString('utf8') ?? '';
}

function packAgentRow(pack: PackOnDisk): PackRow['agent'] {
  const agent = packAgentSection(pack);
  if (agent === null) return null;
  return {
    context: agent.context === undefined ? null : { path: agent.context, text: packFileText(pack, agent.context) },
    skills: agent.skills.map((skillFolder) => ({ name: packSkillNameOf(skillFolder), path: skillFolder, text: packFileText(pack, `${skillFolder}/SKILL.md`) })),
  };
}

function packAgentSkill(pack: PackOnDisk, skillFolder: string): PackAgentSkill {
  const folderPrefix = `${skillFolder}/`;
  const filesByPath = new Map([...pack.filesByPath].filter(([filePath]) => filePath.startsWith(folderPrefix)).map(([filePath, bytes]) => [filePath.slice(folderPrefix.length), bytes]));
  return { skillName: packSkillNameOf(skillFolder), filesByPath };
}

export function packAgentContributions(packs: readonly PackOnDisk[]): PackAgentContribution[] {
  return packs.flatMap((pack) => {
    const agent = packAgentSection(pack);
    const contextBytes = agent?.context === undefined ? undefined : pack.filesByPath.get(agent.context);
    const skillFolders = agent?.skills ?? [];
    const hooks = pack.hooks?.ok ? pack.hooks.value : [];
    if (contextBytes === undefined && skillFolders.length === 0 && hooks.length === 0) return [];
    return [{
      packName: pack.header.name, fingerprint: pack.fingerprint,
      context: agent?.context === undefined || contextBytes === undefined ? null : { fileName: path.posix.basename(agent.context), bytes: contextBytes },
      skills: skillFolders.map((skillFolder) => packAgentSkill(pack, skillFolder)),
      hooks,
      packFiles: hooks.length > 0 ? pack.filesByPath : new Map(),
    }];
  });
}

export function packMcpServers(pack: PackOnDisk): PackMcpServer[] {
  return pack.mcp?.ok ? pack.mcp.value.servers : [];
}

const AGENT_LABELS_BY_MCP_AGENT = { 'claude-code': 'Claude Code', codex: 'Codex', kimi: 'Kimi Code', gemini: 'Gemini CLI', qwen: 'Qwen Code' } as const;
type McpAgentId = keyof typeof AGENT_LABELS_BY_MCP_AGENT;
export type OperatorMcpServerNames = Readonly<Record<McpAgentId, ReadonlySet<string>>>;
export const NO_OPERATOR_MCP_SERVER_NAMES: OperatorMcpServerNames = Object.freeze({ 'claude-code': new Set<string>(), codex: new Set<string>(), kimi: new Set<string>(), gemini: new Set<string>(), qwen: new Set<string>() });

function serverClashNotes(serverName: string, operatorNames: OperatorMcpServerNames): string[] {
  const replacedIn = (['claude-code', 'kimi', 'gemini', 'qwen'] as const).filter((agentId) => operatorNames[agentId].has(serverName)).map((agentId) => AGENT_LABELS_BY_MCP_AGENT[agentId]);
  const replacedNote = replacedIn.length === 0 ? [] : [`Replaces your own ${serverName} server in ${replacedIn.join(' and ')} sessions`];
  const codexNote = operatorNames.codex.has(serverName) ? [`Codex sessions keep your own ${serverName} server, so they leave this one out`] : [];
  return [...replacedNote, ...codexNote];
}

export function packMcpServersForAgent(agentId: string, packs: readonly PackOnDisk[], operatorNames: OperatorMcpServerNames): PackMcpServer[] {
  if (!rendersPackServers(agentId)) return [];
  const servers = packs.flatMap(packMcpServers);
  if (agentId !== 'codex') return servers;
  return servers.filter((server) => !operatorNames.codex.has(server.name));
}

export function packMcpLaunchOf(servers: readonly PackMcpServer[], valueBySecretName: Readonly<Record<string, string>>): PackMcpLaunch {
  const launchedServers = servers.filter((server) => server.secret === undefined || Object.hasOwn(valueBySecretName, server.secret));
  return { servers: launchedServers, env: Object.fromEntries(packSecretNamesOf(launchedServers).map((name) => [packSecretEnvName(name), valueBySecretName[name] ?? ''])) };
}

export function packSecretNamesOf(servers: readonly PackMcpServer[]): string[] {
  return [...new Set(servers.flatMap((server) => (server.secret === undefined ? [] : [server.secret])))];
}

export function packCommandRefsOf(prFlows: PackPrFlowsSection | null, jobs: readonly PackJob[], communitySourceIds: readonly string[]): string[] {
  return [
    ...jobs.map((job) => packCommandRef('job', job.id)),
    ...communitySourceIds.map((id) => packCommandRef('community-source', id)),
    ...packPrFlowCommandRefs(prFlows),
  ];
}

function packPrFlowCommandRefs(prFlows: PackPrFlowsSection | null): string[] {
  if (prFlows === null) return [];
  return [
    ...prFlows.sources.map((command) => packCommandRef('pr-source', command.id)),
    ...prFlows.actions.map((command) => packCommandRef('pr-item-action', command.id)),
    ...prFlows.prActions.map((command) => packCommandRef('pr-action', command.id)),
  ];
}

export function packCommandRef(kind: PackCommandKind, id: string): string {
  return `${kind}:${id}`;
}

export function packSettingsOf(pack: PackOnDisk): PackSetting[] {
  return pack.settings?.ok === true ? pack.settings.value : [];
}

export function secretSettingKeysFor(settings: readonly PackSetting[], commandRef: string): string[] {
  return settings.filter((setting) => setting.kind === 'secret' && settingReachesCommand(setting, commandRef)).map((setting) => setting.key);
}

export function packCommandEnv(settings: readonly PackSetting[], commandRef: string, plainValuesByKey: Readonly<Record<string, string>>, secretValuesByKey: Readonly<Record<string, string>>): Record<string, string> {
  const plainEntries = settings.filter((setting) => setting.kind === 'text' && settingReachesCommand(setting, commandRef) && (plainValuesByKey[setting.key] ?? '') !== '').map((setting) => [setting.key, plainValuesByKey[setting.key] ?? '']);
  const secretEntries = secretSettingKeysFor(settings, commandRef).filter((key) => (secretValuesByKey[key] ?? '') !== '').map((key) => [key, secretValuesByKey[key] ?? '']);
  return Object.fromEntries([...plainEntries, ...secretEntries]);
}

export function missingSettingKeys(settings: readonly PackSetting[], plainValuesByKey: Readonly<Record<string, string>>, foundSecretKeys: ReadonlySet<string>): string[] {
  return settings.filter((setting) => (setting.kind === 'secret' ? !foundSecretKeys.has(setting.key) : (plainValuesByKey[setting.key] ?? '') === '')).map((setting) => setting.key);
}

const MASKED_SECRET_TEXT = '[secret]';
const SHORTEST_MASKED_SECRET_LENGTH = 4;

export function maskSecrets(text: string, secretValues: readonly string[]): string {
  return [...secretValues]
    .filter((value) => value.length >= SHORTEST_MASKED_SECRET_LENGTH)
    .sort((left, right) => right.length - left.length)
    .reduce((masked, value) => masked.replaceAll(value, MASKED_SECRET_TEXT), text);
}

export function maskSecretsInJson(value: unknown, secretValues: readonly string[]): unknown {
  if (secretValues.length === 0 || value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value), (_key, field: unknown) => (typeof field === 'string' ? maskSecrets(field, secretValues) : field));
}

export function packCommunityOf(pack: PackOnDisk): PackCommunity | null {
  return pack.community?.ok === true ? pack.community.value : null;
}

function communityRow(pack: PackOnDisk): PackRow['community'] {
  const community = packCommunityOf(pack);
  if (community === null) return null;
  return { product: community.product.name, docsDomains: community.product.docsDomains, sources: community.sources.map((source) => ({ id: source.id, label: source.label, command: source.command, isJudged: source.judge })) };
}

function settingRows(pack: PackOnDisk): PackRow['settings'] {
  return packSettingsOf(pack).map((setting) => ({ key: setting.key, label: setting.label, kind: setting.kind, hint: setting.hint ?? null, commands: setting.commands }));
}

function serverSecretNotes(server: PackMcpServer): string[] {
  if (server.secret === undefined) return [];
  return [`Sends your ${server.secret} vault secret to ${URL.parse(server.url)?.host ?? server.url} as a bearer token, read by name from your vault once you allow it for the project; while it is denied or cannot be read, a Gemini CLI or Kimi Code session fails its sign-in and any other session leaves this server out`];
}

function validPackRow(pack: PackOnDisk, approvedFingerprints: ReadonlySet<string>, operatorNames: OperatorMcpServerNames): Omit<PackRow, 'isPlacedByHand'> {
  const { prFlowsPacks, warnings: prFlowsErrors } = prFlowsPacksOf([pack]);
  const sectionErrors = [...prFlowsErrors, ...packSectionErrors(pack)];
  const [prFlowsPack] = prFlowsPacks;
  return {
    name: pack.header.name, version: pack.header.version, description: pack.header.description ?? null, dir: pack.dir,
    state: approvedFingerprints.has(pack.fingerprint) ? 'approved' : 'pending', fingerprint: pack.fingerprint,
    files: [...pack.filesByPath.keys()].sort(), needs: packNeeds(pack), missingRequires: pack.missingRequires,
    prFlows: prFlowsPack ? packApproval(prFlowsPack) : null,
    themes: packThemes(pack).map((theme) => ({ id: theme.id, label: theme.label, mode: theme.mode, swatch: themeSwatchOf(theme) })),
    previewDataUrl: pack.previewDataUrl,
    panels: packPanels(pack).map((panel) => ({ id: panel.id, label: panel.label, reads: panel.reads, acts: panel.acts })),
    launchers: packLaunchers(pack).map((launcher) => ({ id: launcher.id, label: launcher.label, project: launcher.project, agent: launcher.agent, model: launcher.model ?? null, effort: launcher.effort ?? null, prompt: launcher.prompt, schedule: launcher.schedule ?? null })),
    sessions: packSessionSettings(pack), statusUrls: packStatusUrls(pack), agent: packAgentRow(pack),
    mcpServers: packMcpServers(pack).map((server) => ({ name: server.name, url: server.url, notes: [...serverSecretNotes(server), ...serverClashNotes(server.name, operatorNames)] })),
    hooks: packHooksOf(pack).map((hook) => ({ id: hook.id, description: hook.description, tools: hook.tools, command: hook.command })), settings: settingRows(pack), community: communityRow(pack), jobs: packJobsOf(pack).map((job) => ({ id: job.id, label: job.label, schedule: job.schedule, command: job.command })), errors: sectionErrors,
  };
}

export function packRow(packDir: string, read: PackRead, approvedFingerprints: ReadonlySet<string>, isPlacedByHand: boolean, operatorNames: OperatorMcpServerNames): PackRow {
  if (read.ok) return { ...validPackRow(read.pack, approvedFingerprints, operatorNames), isPlacedByHand };
  return {
    name: path.basename(packDir), version: null, description: null, dir: packDir, state: 'invalid', fingerprint: null,
    files: [], needs: [], missingRequires: [], prFlows: null, themes: [], previewDataUrl: null, panels: [], launchers: [], sessions: null, statusUrls: [], agent: null, mcpServers: [], hooks: [], settings: [], community: null, jobs: [], errors: read.errors, isPlacedByHand,
  };
}

export const PACK_ICON_MAX_BYTES = 16 * 1024;
export const SOURCE_ICONS_MAX_BYTES = 256 * 1024;
export const PACK_PREVIEW_MAX_BYTES = 32 * 1024;
const PACK_PREVIEWS_MAX_BYTES = 256 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function themeSwatchOf(palette: ThemePalette): PackThemeSwatch {
  return { bg: palette.chrome.bg, card: palette.chrome['bg-card'], text: palette.chrome.text, accent: palette.chrome.accent };
}

function previewMimeOf(previewBytes: Buffer): string | null {
  if (previewBytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'image/png';
  const isWebp = previewBytes.toString('latin1', 0, 4) === 'RIFF' && previewBytes.toString('latin1', 8, 12) === 'WEBP';
  return isWebp ? 'image/webp' : null;
}

export function packPreviewDataUrl(previewBytes: Buffer): string | null {
  if (previewBytes.length > PACK_PREVIEW_MAX_BYTES) return null;
  const mime = previewMimeOf(previewBytes);
  return mime === null ? null : `data:${mime};base64,${previewBytes.toString('base64')}`;
}

export function withinPreviewBudget<Row extends { previewDataUrl: string | null }>(rows: readonly Row[]): Row[] {
  let remainingPreviewBytes = PACK_PREVIEWS_MAX_BYTES;
  return rows.map((row) => {
    if (row.previewDataUrl === null) return row;
    if (row.previewDataUrl.length > remainingPreviewBytes) return { ...row, previewDataUrl: null };
    remainingPreviewBytes -= row.previewDataUrl.length;
    return row;
  });
}

type SourcePackDetails = Pick<PackSourceRow['packs'][number], 'version' | 'description' | 'kinds' | 'themeSwatches'> & { iconPath: string | null; previewPath: string | null };

function parsedOrNull<Value>(schema: z.ZodType<Value>, raw: unknown): Value | null {
  if (raw === undefined) return null;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function sourcePackDetails(header: PackHeader): SourcePackDetails {
  const ui = parsedOrNull(PackUi, header.ui);
  const agent = parsedOrNull(PackAgent, header.agent);
  const kinds = packKindLabels({
    panels: ui?.panels ?? [], themes: ui?.themes ?? [], launchers: parsedOrNull(PackLaunchers, header.launchers) ?? [],
    agent: agent === null ? null : { context: agent.context ?? null, skills: agent.skills },
    mcpServers: parsedOrNull(PackMcp, header.mcp)?.servers ?? [],
    hooks: parsedOrNull(PackHooks, header.hooks) ?? [],
    prFlows: parsedOrNull(PackPrFlows, header.prFlows),
    communitySources: parsedOrNull(PackCommunity, header.community)?.sources ?? [],
    jobs: parsedOrNull(PackJobs, header.jobs) ?? [],
    settings: parsedOrNull(PackSettings, header.settings) ?? [],
  });
  const iconPath = ui?.panels.find((panel) => panel.icon !== undefined)?.icon ?? null;
  return { version: header.version, description: header.description ?? null, kinds, themeSwatches: (ui?.themes ?? []).map(themeSwatchOf), iconPath, previewPath: header.preview ?? null };
}

export function packIconDataUrl(iconBytes: Buffer): string {
  return `data:image/svg+xml;base64,${iconBytes.toString('base64')}`;
}

export function pendingPackNote(row: PackRow): string {
  return `The pack '${row.name}' waits for your approval in the Packs tab`;
}

const MAX_REFERENCE_LENGTH = 512;
const ATTRIBUTE_VALUE = `(?:"([^"]{0,${MAX_REFERENCE_LENGTH}})"|'([^']{0,${MAX_REFERENCE_LENGTH}})'|([^\\s"'>]{1,${MAX_REFERENCE_LENGTH}}))`;
const HTML_REFERENCE_PATTERN = new RegExp(`\\b(src|href|poster|srcset|imagesrcset)\\s*=\\s*${ATTRIBUTE_VALUE}`, 'gi');
const CSS_REFERENCE_PATTERN = new RegExp(`url\\(\\s*["']?([^"')]{0,${MAX_REFERENCE_LENGTH}})["']?\\s*\\)|@import\\s+["']([^"']{1,${MAX_REFERENCE_LENGTH}})["']`, 'gi');
const INERT_REFERENCE_PATTERN = /^(?:#|data:|blob:|javascript:|about:|mailto:)/i;
export const REMOTE_REFERENCE_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function withoutDelimited(text: string, opener: string, closer: string): string {
  const keptParts: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const openAt = text.indexOf(opener, cursor);
    if (openAt === -1) return [...keptParts, text.slice(cursor)].join('');
    keptParts.push(text.slice(cursor, openAt));
    const closeAt = text.indexOf(closer, openAt + opener.length);
    if (closeAt === -1) return keptParts.join('');
    cursor = closeAt + closer.length;
  }
  return keptParts.join('');
}

function attributeUrls(attributeName: string, value: string): string[] {
  if (!attributeName.toLowerCase().endsWith('srcset')) return [value];
  return value.split(',').map((candidate) => candidate.trim().split(/\s+/)[0] ?? '');
}

const JS_IMPORT_PATTERN = new RegExp(`\\b(?:import|export)\\b[^;'"]{0,${MAX_REFERENCE_LENGTH}}?\\bfrom\\s{0,64}["']([^"']{1,${MAX_REFERENCE_LENGTH}})["']|\\bimport\\s{0,64}\\(?\\s{0,64}["']([^"']{1,${MAX_REFERENCE_LENGTH}})["']`, 'g');
const LINE_COMMENT_PATTERN = /^[ \t]*\/\/.*$/gm;
const RELATIVE_IMPORT_PATTERN = /^\.{1,2}\//;

export function isScriptFile(filePath: string): boolean {
  return filePath.endsWith('.js') || filePath.endsWith('.mjs');
}

type PageReference = { url: string; isImport: boolean };

function jsImportsIn(text: string): PageReference[] {
  return [...withoutDelimited(text, '/*', '*/').replace(LINE_COMMENT_PATTERN, '').matchAll(JS_IMPORT_PATTERN)].map((match) => ({ url: match[1] ?? match[2] ?? '', isImport: true }));
}

function linkReferences(urls: string[]): PageReference[] {
  return urls.map((url) => ({ url, isImport: false }));
}

function inlineScriptsIn(html: string): string[] {
  const scriptBodies: string[] = [];
  const lowerHtml = html.toLowerCase();
  let cursor = 0;
  while (cursor < html.length) {
    const openAt = lowerHtml.indexOf('<script', cursor);
    const bodyStart = openAt === -1 ? -1 : lowerHtml.indexOf('>', openAt);
    const closeAt = bodyStart === -1 ? -1 : lowerHtml.indexOf('</script', bodyStart);
    if (closeAt === -1) return scriptBodies;
    scriptBodies.push(html.slice(bodyStart + 1, closeAt));
    cursor = closeAt;
  }
  return scriptBodies;
}

function rawReferencesIn(filePath: string, text: string): PageReference[] {
  if (isScriptFile(filePath)) return jsImportsIn(text);
  const withoutComments = withoutDelimited(withoutDelimited(text, '<!--', '-->'), '/*', '*/');
  const cssReferences = linkReferences([...withoutComments.matchAll(CSS_REFERENCE_PATTERN)].map((match) => match[1] ?? match[2] ?? ''));
  if (!filePath.endsWith('.html')) return cssReferences;
  const attributeReferences = linkReferences([...withoutComments.matchAll(HTML_REFERENCE_PATTERN)].flatMap((match) => attributeUrls(match[1] ?? '', match[2] ?? match[3] ?? match[4] ?? '')));
  return [...attributeReferences, ...inlineScriptsIn(withoutComments).flatMap(jsImportsIn), ...cssReferences];
}

export function referencesIn(filePath: string, text: string): PageReference[] {
  return rawReferencesIn(filePath, text).map((reference) => ({ ...reference, url: reference.url.trim() })).filter((reference) => reference.url !== '' && !INERT_REFERENCE_PATTERN.test(reference.url));
}

type ReferenceReplacer = (url: string) => string | null;

function replacedUrl(url: string, replacementOf: ReferenceReplacer): string {
  const trimmedUrl = url.trim();
  if (trimmedUrl === '' || INERT_REFERENCE_PATTERN.test(trimmedUrl)) return url;
  return replacementOf(trimmedUrl) ?? url;
}

function withValueReplaced(match: string, value: string, replacement: string): string {
  if (replacement === value) return match;
  const valueAt = match.lastIndexOf(value);
  return `${match.slice(0, valueAt)}${replacement}${match.slice(valueAt + value.length)}`;
}

function withJsImportsReplaced(text: string, replacementOf: ReferenceReplacer): string {
  return text.replace(JS_IMPORT_PATTERN, (match, fromSpecifier: string | undefined, importedSpecifier: string | undefined) => {
    const specifier = fromSpecifier ?? importedSpecifier ?? '';
    return withValueReplaced(match, specifier, replacedUrl(specifier, replacementOf));
  });
}

function withCssReferencesReplaced(text: string, replacementOf: ReferenceReplacer): string {
  return text.replace(CSS_REFERENCE_PATTERN, (match, urlValue: string | undefined, importedValue: string | undefined) => {
    const value = urlValue ?? importedValue ?? '';
    return withValueReplaced(match, value, replacedUrl(value, replacementOf));
  });
}

function srcsetReplaced(srcset: string, replacementOf: ReferenceReplacer): string {
  return srcset.split(',').map((candidate) => {
    const url = candidate.trim().split(/\s+/)[0] ?? '';
    return url === '' ? candidate : candidate.replace(url, replacedUrl(url, replacementOf));
  }).join(',');
}

function withScriptBodiesReplaced(html: string, replacedBody: (body: string) => string): string {
  const keptParts: string[] = [];
  const lowerHtml = html.toLowerCase();
  let cursor = 0;
  while (cursor < html.length) {
    const openAt = lowerHtml.indexOf('<script', cursor);
    const bodyStart = openAt === -1 ? -1 : lowerHtml.indexOf('>', openAt);
    const closeAt = bodyStart === -1 ? -1 : lowerHtml.indexOf('</script', bodyStart);
    if (closeAt === -1) break;
    keptParts.push(html.slice(cursor, bodyStart + 1), replacedBody(html.slice(bodyStart + 1, closeAt)));
    cursor = closeAt;
  }
  keptParts.push(html.slice(cursor));
  return keptParts.join('');
}

function withHtmlReferencesReplaced(html: string, replacementOf: ReferenceReplacer): string {
  const withScriptImports = withScriptBodiesReplaced(html, (body) => withJsImportsReplaced(body, replacementOf));
  const withAttributes = withScriptImports.replace(HTML_REFERENCE_PATTERN, (match, attributeName: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined) => {
    const value = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
    const replacement = attributeName.toLowerCase().endsWith('srcset') ? srcsetReplaced(value, replacementOf) : replacedUrl(value, replacementOf);
    return withValueReplaced(match, value, replacement);
  });
  return withCssReferencesReplaced(withAttributes, replacementOf);
}

export function withReferencesReplaced(filePath: string, text: string, replacementOf: ReferenceReplacer): string {
  if (isScriptFile(filePath)) return withJsImportsReplaced(text, replacementOf);
  if (!filePath.endsWith('.html')) return withCssReferencesReplaced(text, replacementOf);
  return withHtmlReferencesReplaced(text, replacementOf);
}

function decodedPath(reference: string): string {
  try {
    return decodeURIComponent(reference);
  } catch {
    return reference;
  }
}

function referenceError(filePath: string, { url: reference, isImport }: PageReference, filesByPath: ReadonlyMap<string, Buffer>): string | null {
  if (REMOTE_REFERENCE_PATTERN.test(reference)) return `${filePath} loads ${reference}, but a panel has no network; put that file in the pack`;
  if (reference.startsWith('/')) return `${filePath} refers to ${reference}, an absolute path that leaves the pack; use a path relative to ${filePath}`;
  if (isImport && !RELATIVE_IMPORT_PATTERN.test(reference)) return `${filePath} imports ${reference}, but a panel has no package resolver; import a file in the pack by a path starting with ./ or ../`;
  const referencedPath = referencedPackPath(filePath, reference);
  if (referencedPath.startsWith('../')) return `${filePath} refers to ${reference}, which is outside the pack`;
  return filesByPath.has(referencedPath) ? null : `${filePath} refers to ${reference}, which is not a file in the pack`;
}

export function referencedPackPath(filePath: string, reference: string): string {
  return path.posix.normalize(path.posix.join(path.posix.dirname(filePath), decodedPath(reference.replace(/[?#].*$/, ''))));
}

export function panelReferenceErrors(filesByPath: ReadonlyMap<string, Buffer>, panelEntries: readonly string[]): string[] {
  const panelPagePaths = new Set(panelEntries.flatMap((entry) => filesLoadedFrom(entry, filesByPath)));
  return [...filesByPath].filter(([filePath]) => filePath.endsWith('.css') || panelPagePaths.has(filePath)).flatMap(([filePath, bytes]) => referencesIn(filePath, bytes.toString('utf8'))
    .map((reference) => referenceError(filePath, reference, filesByPath))
    .filter((error) => error !== null));
}

const SUBSCRIBED_TOPICS_PATTERN = /subscribe\(\s*\[([^\]]{0,500})\]|kind\s*:\s*['"]subscribe['"][^}]{0,500}?topics\s*:\s*\[([^\]]{0,500})\]/g;

function filesLoadedFrom(entry: string, filesByPath: ReadonlyMap<string, Buffer>): string[] {
  const loadedPaths = new Set<string>();
  const pendingPaths = [entry];
  while (pendingPaths.length > 0) {
    const filePath = pendingPaths.pop() ?? '';
    const bytes = filesByPath.get(filePath);
    if (loadedPaths.has(filePath) || bytes === undefined) continue;
    loadedPaths.add(filePath);
    if (!filePath.endsWith('.html') && !isScriptFile(filePath)) continue;
    pendingPaths.push(...referencesIn(filePath, bytes.toString('utf8')).filter(({ url }) => !REMOTE_REFERENCE_PATTERN.test(url) && !url.startsWith('/')).map(({ url }) => referencedPackPath(filePath, url)));
  }
  return [...loadedPaths].filter((filePath) => filePath.endsWith('.html') || isScriptFile(filePath));
}

function subscribedTopicsIn(text: string): string[] {
  return [...text.matchAll(SUBSCRIBED_TOPICS_PATTERN)].flatMap((match) => [...(match[1] ?? match[2] ?? '').matchAll(/['"]([^'"]+)['"]/g)].map((topic) => topic[1] ?? ''));
}

export function undeclaredSubscriptionErrors(filesByPath: ReadonlyMap<string, Buffer>, panels: readonly { id: string; entry: string; reads: readonly string[] }[]): string[] {
  return panels.flatMap((panel) => filesLoadedFrom(panel.entry, filesByPath).flatMap((filePath) => [...new Set(subscribedTopicsIn(filesByPath.get(filePath)?.toString('utf8') ?? ''))]
    .filter((topic) => !panel.reads.includes(topic))
    .map((topic) => `${filePath} subscribes to '${topic}', which panel ${panel.id} does not list under reads, so it never arrives there; add it to that panel's reads or drop it`)));
}
