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
    themes: packThemes(pack).map((theme) => ({ id: theme.id, label: theme.label, mode: theme.mode })), errors: sectionErrors,
  };
}

export function packRow(packDir: string, read: PackRead, approvedFingerprints: ReadonlySet<string>): PackRow {
  if (read.ok) return validPackRow(read.pack, approvedFingerprints);
  return {
    name: path.basename(packDir), version: null, description: null, dir: packDir, state: 'invalid', fingerprint: null,
    files: [], needs: [], missingRequires: [], prFlows: null, themes: [], errors: read.errors,
  };
}

export function pendingPackNote(row: PackRow): string {
  return `The pack '${row.name}' waits for your approval in Settings, Packs`;
}
