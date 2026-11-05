import path from 'node:path';
import type { PackRow, PacksStatus } from '../../../shared/contracts/control/pack-messages.ts';
import type { PackOnDisk, PackUi } from '../../../shared/contracts/pack.ts';
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
    viewId: `pack:${pack.header.name}/${panel.id}`, label: panel.label, entryUrl: packFileUrl(pack, accessKeyOf(pack), panel.entry),
    iconUrl: panel.icon ? packFileUrl(pack, accessKeyOf(pack), panel.icon) : null, reads: panel.reads,
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

export function packFileHeaders(filePath: string): Record<string, string> {
  return { 'Content-Security-Policy': PACK_PANEL_CONTENT_POLICY, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Type': packFileMime(filePath) };
}

export function uiSectionErrors(pack: PackOnDisk): string[] {
  return pack.ui && !pack.ui.ok ? pack.ui.errors : [];
}

function validPackRow(pack: PackOnDisk, approvedFingerprints: ReadonlySet<string>): PackRow {
  const { prFlowsPacks, warnings: prFlowsErrors } = prFlowsPacksOf([pack]);
  const sectionErrors = [...prFlowsErrors, ...uiSectionErrors(pack)];
  const [prFlowsPack] = prFlowsPacks;
  return {
    name: pack.header.name, version: pack.header.version, description: pack.header.description ?? null, dir: pack.dir,
    state: approvedFingerprints.has(pack.fingerprint) ? 'approved' : 'pending', fingerprint: pack.fingerprint,
    files: [...pack.filesByPath.keys()].sort(), needs: packNeeds(pack), missingRequires: pack.missingRequires,
    prFlows: prFlowsPack ? packApproval(prFlowsPack) : null,
    themes: packThemes(pack).map((theme) => ({ id: theme.id, label: theme.label, mode: theme.mode })),
    panels: packPanels(pack).map((panel) => ({ id: panel.id, label: panel.label, reads: panel.reads })), errors: sectionErrors,
  };
}

export function packRow(packDir: string, read: PackRead, approvedFingerprints: ReadonlySet<string>): PackRow {
  if (read.ok) return validPackRow(read.pack, approvedFingerprints);
  return {
    name: path.basename(packDir), version: null, description: null, dir: packDir, state: 'invalid', fingerprint: null,
    files: [], needs: [], missingRequires: [], prFlows: null, themes: [], panels: [], errors: read.errors,
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

function referencesIn(filePath: string, text: string): string[] {
  const withoutComments = withoutDelimited(withoutDelimited(text, '<!--', '-->'), '/*', '*/');
  const cssReferences = [...withoutComments.matchAll(CSS_REFERENCE_PATTERN)].map((match) => match[1] ?? match[2] ?? '');
  const htmlReferences = filePath.endsWith('.html')
    ? [...withoutComments.matchAll(HTML_REFERENCE_PATTERN)].flatMap((match) => attributeUrls(match[1] ?? '', match[2] ?? match[3] ?? match[4] ?? ''))
    : [];
  return [...htmlReferences, ...cssReferences].map((reference) => reference.trim()).filter((reference) => reference !== '' && !INERT_REFERENCE_PATTERN.test(reference));
}

function decodedPath(reference: string): string {
  try {
    return decodeURIComponent(reference);
  } catch {
    return reference;
  }
}

function referenceError(filePath: string, reference: string, filesByPath: ReadonlyMap<string, Buffer>): string | null {
  if (REMOTE_REFERENCE_PATTERN.test(reference)) return `${filePath} loads ${reference}, but a panel has no network; put that file in the pack`;
  if (reference.startsWith('/')) return `${filePath} refers to ${reference}, an absolute path that leaves the pack; use a path relative to ${filePath}`;
  const referencedPath = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), decodedPath(reference.replace(/[?#].*$/, ''))));
  if (referencedPath.startsWith('../')) return `${filePath} refers to ${reference}, which is outside the pack`;
  return filesByPath.has(referencedPath) ? null : `${filePath} refers to ${reference}, which is not a file in the pack`;
}

export function panelReferenceErrors(filesByPath: ReadonlyMap<string, Buffer>): string[] {
  return [...filesByPath].filter(([filePath]) => filePath.endsWith('.html') || filePath.endsWith('.css')).flatMap(([filePath, bytes]) => referencesIn(filePath, bytes.toString('utf8'))
    .map((reference) => referenceError(filePath, reference, filesByPath))
    .filter((error) => error !== null));
}

const SUBSCRIBED_TOPICS_PATTERN = /subscribe\(\s*\[([^\]]{0,500})\]|kind\s*:\s*['"]subscribe['"][^}]{0,500}?topics\s*:\s*\[([^\]]{0,500})\]/g;

export function undeclaredSubscriptionErrors(filesByPath: ReadonlyMap<string, Buffer>, declaredReads: ReadonlySet<string>): string[] {
  return [...filesByPath].filter(([filePath]) => filePath.endsWith('.js') || filePath.endsWith('.html')).flatMap(([filePath, bytes]) => {
    const subscribedTopics = [...bytes.toString('utf8').matchAll(SUBSCRIBED_TOPICS_PATTERN)].flatMap((match) => [...(match[1] ?? match[2] ?? '').matchAll(/['"]([^'"]+)['"]/g)].map((topic) => topic[1] ?? ''));
    return [...new Set(subscribedTopics)].filter((topic) => !declaredReads.has(topic))
      .map((topic) => `${filePath} subscribes to '${topic}', which no panel lists under reads, so it never arrives; add it to reads or drop it`);
  });
}
