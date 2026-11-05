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

export function packFileMime(filePath: string): string {
  return PACK_FILE_MIME_BY_EXTENSION[path.posix.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
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
