import path from 'node:path';
import type { PackRow, PackSourceRow, PacksStatus } from '../../../shared/contracts/control/pack-messages.ts';
import { packSkillNameOf } from '../../../shared/contracts/pack.ts';
import { packKindLabels } from '../../../shared/pack-approval.ts';
import type { z } from 'zod';
import { PackAgent, PackLaunchers, PackPrFlows, PackUi } from '../../../shared/contracts/pack.ts';
import type { PackHeader, PackLauncher, PackOnDisk, PackSessions } from '../../../shared/contracts/pack.ts';
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
  return [pack.ui, pack.launchers, pack.sessions, pack.status, pack.agent].flatMap((section) => (section && !section.ok ? section.errors : []));
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

export type ScheduledPackLauncher = { pack: string; launcher: PackLauncher; schedule: string };

export function scheduledLaunchers(packs: readonly PackOnDisk[]): ScheduledPackLauncher[] {
  return packs.flatMap((pack) => packLaunchers(pack).flatMap((launcher) => (launcher.schedule ? [{ pack: pack.header.name, launcher, schedule: launcher.schedule }] : [])));
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
    if (agent === null || (contextBytes === undefined && agent.skills.length === 0)) return [];
    return [{
      packName: pack.header.name, fingerprint: pack.fingerprint,
      context: agent.context === undefined || contextBytes === undefined ? null : { fileName: path.posix.basename(agent.context), bytes: contextBytes },
      skills: agent.skills.map((skillFolder) => packAgentSkill(pack, skillFolder)),
    }];
  });
}

function validPackRow(pack: PackOnDisk, approvedFingerprints: ReadonlySet<string>): Omit<PackRow, 'isPlacedByHand'> {
  const { prFlowsPacks, warnings: prFlowsErrors } = prFlowsPacksOf([pack]);
  const sectionErrors = [...prFlowsErrors, ...packSectionErrors(pack)];
  const [prFlowsPack] = prFlowsPacks;
  return {
    name: pack.header.name, version: pack.header.version, description: pack.header.description ?? null, dir: pack.dir,
    state: approvedFingerprints.has(pack.fingerprint) ? 'approved' : 'pending', fingerprint: pack.fingerprint,
    files: [...pack.filesByPath.keys()].sort(), needs: packNeeds(pack), missingRequires: pack.missingRequires,
    prFlows: prFlowsPack ? packApproval(prFlowsPack) : null,
    themes: packThemes(pack).map((theme) => ({ id: theme.id, label: theme.label, mode: theme.mode })),
    panels: packPanels(pack).map((panel) => ({ id: panel.id, label: panel.label, reads: panel.reads, acts: panel.acts })),
    launchers: packLaunchers(pack).map((launcher) => ({ id: launcher.id, label: launcher.label, project: launcher.project, agent: launcher.agent, model: launcher.model ?? null, effort: launcher.effort ?? null, prompt: launcher.prompt, schedule: launcher.schedule ?? null })),
    sessions: packSessionSettings(pack), statusUrls: packStatusUrls(pack), agent: packAgentRow(pack), errors: sectionErrors,
  };
}

export function packRow(packDir: string, read: PackRead, approvedFingerprints: ReadonlySet<string>, isPlacedByHand: boolean): PackRow {
  if (read.ok) return { ...validPackRow(read.pack, approvedFingerprints), isPlacedByHand };
  return {
    name: path.basename(packDir), version: null, description: null, dir: packDir, state: 'invalid', fingerprint: null,
    files: [], needs: [], missingRequires: [], prFlows: null, themes: [], panels: [], launchers: [], sessions: null, statusUrls: [], agent: null, errors: read.errors, isPlacedByHand,
  };
}

export const PACK_ICON_MAX_BYTES = 16 * 1024;
export const SOURCE_ICONS_MAX_BYTES = 256 * 1024;

type SourcePackDetails = Pick<PackSourceRow['packs'][number], 'version' | 'description' | 'kinds'> & { iconPath: string | null };

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
    prFlows: parsedOrNull(PackPrFlows, header.prFlows),
  });
  const iconPath = ui?.panels.find((panel) => panel.icon !== undefined)?.icon ?? null;
  return { version: header.version, description: header.description ?? null, kinds, iconPath };
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

export function panelReferenceErrors(filesByPath: ReadonlyMap<string, Buffer>): string[] {
  return [...filesByPath].filter(([filePath]) => filePath.endsWith('.html') || filePath.endsWith('.css') || isScriptFile(filePath)).flatMap(([filePath, bytes]) => referencesIn(filePath, bytes.toString('utf8'))
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
