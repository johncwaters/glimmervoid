import { z } from 'zod';
import { PrFlowPendingApproval } from '../pr-flows.ts';
import { ThemePalette } from '../theme-palette.ts';
import { PackBridgeTopic, PackName, PackPanelAct, PackStoreData, PackStoreKey, PackStoreValue } from '../pack-bridge.ts';
import { loose, optionalError, requestId } from './control-fields.ts';

const PackRowState = z.enum(['pending', 'approved', 'invalid']);


export const PackRow = z.strictObject({
  name: z.string(),
  version: z.number().nullable(),
  description: z.string().nullable(),
  dir: z.string(),
  state: PackRowState,
  fingerprint: z.string().nullable(),
  files: z.array(z.string()),
  needs: z.array(z.string()),
  missingRequires: z.array(z.string()),
  prFlows: PrFlowPendingApproval.nullable(),
  themes: z.array(z.strictObject({ id: z.string(), label: z.string(), mode: ThemePalette.shape.mode })),
  panels: z.array(z.strictObject({ id: z.string(), label: z.string(), reads: z.array(PackBridgeTopic), acts: z.array(PackPanelAct) })),
  mcpServers: z.array(z.strictObject({ name: z.string(), url: z.string(), notes: z.array(z.string()) })),
  errors: z.array(z.string()),
});
export type PackRow = z.infer<typeof PackRow>;

const ApprovedPackTheme = z.strictObject({ id: z.string(), palette: ThemePalette });

const ApprovedPackPanel = z.strictObject({
  viewId: z.string(), pack: z.string(), label: z.string(), entryUrl: z.string(), iconUrl: z.string().nullable(), reads: z.array(PackBridgeTopic), acts: z.array(PackPanelAct),
});

export const ExamplePack = z.strictObject({ name: PackName, description: z.string().nullable(), isAdded: z.boolean() });
export type ExamplePack = z.infer<typeof ExamplePack>;

export const PacksStatus = loose('packs-status', { packs: z.array(PackRow), examples: z.array(ExamplePack), themes: z.array(ApprovedPackTheme), panels: z.array(ApprovedPackPanel), warnings: z.array(z.string()) });
export type PacksStatus = z.infer<typeof PacksStatus>;

export const PackApproveRequest = z.strictObject({ fingerprint: z.string().min(1).max(128) });

const PackDataRequest = { requestId, pack: PackName };

export const packClientVariants = [
  loose('pack-approve', { ...PackApproveRequest.shape, requestId }),
  loose('pack-add-example', { name: PackName, requestId }),
  loose('pack-data-get', PackDataRequest),
  loose('pack-data-set', { ...PackDataRequest, key: PackStoreKey, value: PackStoreValue }),
] as const;

export const packServerVariants = [
  PacksStatus,
  loose('pack-approve-result', { requestId, ok: z.boolean(), error: optionalError }),
  loose('pack-add-example-result', { requestId, ok: z.boolean(), error: optionalError }),
  loose('pack-data-result', { requestId, ok: z.boolean(), data: PackStoreData.optional(), error: optionalError }),
] as const;
