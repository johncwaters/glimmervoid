import path from 'node:path';
import type { PackRow, PacksStatus } from '../../../shared/contracts/control/pack-messages.ts';
import type { PackMcpLaunch, PackMcpServer, PackOnDisk, PackUi } from '../../../shared/contracts/pack.ts';
import { packSecretEnvName, rendersPackServers } from '../../../mcp/core/agent-config.ts';
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

function packFileUrl(pack: PackOnDisk, accessKey: string, filePath: string): string {
  return `/packs/${encodeURIComponent(pack.header.name)}/${accessKey}/files/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

export function approvedPackPanels(packs: readonly PackOnDisk[], accessKeyOf: (pack: PackOnDisk) => string): PacksStatus['panels'] {
  return packs.flatMap((pack) => packPanels(pack).map((panel) => ({
    viewId: `pack:${pack.header.name}/${panel.id}`, pack: pack.header.name, label: panel.label, entryUrl: packFileUrl(pack, accessKeyOf(pack), panel.entry),
    iconUrl: panel.icon ? packFileUrl(pack, accessKeyOf(pack), panel.icon) : null, reads: panel.reads, acts: panel.acts,
  })));
}

const PACK_FILE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
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

function packFileMime(filePath: string): string {
  return PACK_FILE_MIME_BY_EXTENSION[path.posix.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

const OPAQUE_ORIGIN = 'null';

export function packFileHeaders(filePath: string, requestOrigin: string | undefined): Record<string, string> {
  const headers = { 'Content-Security-Policy': PACK_PANEL_CONTENT_POLICY, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Type': packFileMime(filePath), Vary: 'Origin' };
  return requestOrigin === OPAQUE_ORIGIN ? { ...headers, 'Access-Control-Allow-Origin': OPAQUE_ORIGIN } : headers;
}

export function packSectionErrors(pack: PackOnDisk): string[] {
  return [pack.ui, pack.mcp].flatMap((section) => (section && !section.ok ? section.errors : []));
}

export function packMcpServers(pack: PackOnDisk): PackMcpServer[] {
  return pack.mcp?.ok ? pack.mcp.value.servers : [];
}

const AGENT_LABELS_BY_MCP_AGENT = { 'claude-code': 'Claude Code', codex: 'Codex', kimi: 'Kimi Code' } as const;
type McpAgentId = keyof typeof AGENT_LABELS_BY_MCP_AGENT;
export type OperatorMcpServerNames = Readonly<Record<McpAgentId, ReadonlySet<string>>>;
export const NO_OPERATOR_MCP_SERVER_NAMES: OperatorMcpServerNames = Object.freeze({ 'claude-code': new Set<string>(), codex: new Set<string>(), kimi: new Set<string>() });

function serverClashNotes(serverName: string, operatorNames: OperatorMcpServerNames): string[] {
  const replacedIn = (['claude-code', 'kimi'] as const).filter((agentId) => operatorNames[agentId].has(serverName)).map((agentId) => AGENT_LABELS_BY_MCP_AGENT[agentId]);
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
  const secretNames = new Set(launchedServers.flatMap((server) => (server.secret === undefined ? [] : [server.secret])));
  return { servers: launchedServers, env: Object.fromEntries([...secretNames].map((name) => [packSecretEnvName(name), valueBySecretName[name] ?? ''])) };
}

export function declaredPackSecretsOf(packs: readonly PackOnDisk[]): { name: string; packs: string[] }[] {
  return packs.flatMap((pack) => [...new Set(packMcpServers(pack).flatMap((server) => (server.secret === undefined ? [] : [server.secret])))].map((name) => ({ name, packs: [pack.header.name] })));
}

function serverSecretNotes(server: PackMcpServer): string[] {
  if (server.secret === undefined) return [];
  return [`Sends your ${server.secret} vault secret to ${URL.parse(server.url)?.host ?? server.url} as a bearer token; link it in Settings, Vault, and sessions leave this server out until glimmervoid vault can read it`];
}

function validPackRow(pack: PackOnDisk, approvedFingerprints: ReadonlySet<string>, operatorNames: OperatorMcpServerNames): PackRow {
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
    mcpServers: packMcpServers(pack).map((server) => ({ name: server.name, url: server.url, notes: [...serverSecretNotes(server), ...serverClashNotes(server.name, operatorNames)] })), errors: sectionErrors,
  };
}

export function packRow(packDir: string, read: PackRead, approvedFingerprints: ReadonlySet<string>, operatorNames: OperatorMcpServerNames): PackRow {
  if (read.ok) return validPackRow(read.pack, approvedFingerprints, operatorNames);
  return {
    name: path.basename(packDir), version: null, description: null, dir: packDir, state: 'invalid', fingerprint: null,
    files: [], needs: [], missingRequires: [], prFlows: null, themes: [], panels: [], mcpServers: [], errors: read.errors,
  };
}

export function pendingPackNote(row: PackRow): string {
  return `The pack '${row.name}' waits for your approval in Settings, Packs`;
}

const MAX_REFERENCE_LENGTH = 512;
const ATTRIBUTE_VALUE = `(?:"([^"]{0,${MAX_REFERENCE_LENGTH}})"|'([^']{0,${MAX_REFERENCE_LENGTH}})'|([^\\s"'>]{1,${MAX_REFERENCE_LENGTH}}))`;
const HTML_REFERENCE_PATTERN = new RegExp(`\\b(src|href|poster|srcset|imagesrcset)\\s*=\\s*${ATTRIBUTE_VALUE}`, 'gi');
const CSS_REFERENCE_PATTERN = new RegExp(`url\\(\\s*["']?([^"')]{0,${MAX_REFERENCE_LENGTH}})["']?\\s*\\)|@import\\s+["']([^"']{1,${MAX_REFERENCE_LENGTH}})["']`, 'gi');
const INERT_REFERENCE_PATTERN = /^(?:#|data:|blob:|javascript:|about:|mailto:)/i;
const REMOTE_REFERENCE_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

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

function isScriptFile(filePath: string): boolean {
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

function referencesIn(filePath: string, text: string): PageReference[] {
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

function referencedPackPath(filePath: string, reference: string): string {
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
