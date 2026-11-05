import { z } from 'zod';
import { PrFlowPendingApproval } from '../pr-flows.ts';
import { ThemePalette } from '../theme-palette.ts';
import { PackBridgeTopic } from '../pack-bridge.ts';
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
  panels: z.array(z.strictObject({ id: z.string(), label: z.string(), reads: z.array(PackBridgeTopic) })),
  errors: z.array(z.string()),
});
export type PackRow = z.infer<typeof PackRow>;

const ApprovedPackTheme = z.strictObject({ id: z.string(), palette: ThemePalette });

const ApprovedPackPanel = z.strictObject({
  viewId: z.string(), label: z.string(), entryUrl: z.string(), iconUrl: z.string().nullable(), reads: z.array(PackBridgeTopic),
});

export const PacksStatus = loose('packs-status', { packs: z.array(PackRow), themes: z.array(ApprovedPackTheme), panels: z.array(ApprovedPackPanel), warnings: z.array(z.string()) });
export type PacksStatus = z.infer<typeof PacksStatus>;

export const PackApproveRequest = z.strictObject({ fingerprint: z.string().min(1).max(128) });

export const packClientVariants = [
  loose('pack-approve', { ...PackApproveRequest.shape, requestId }),
] as const;

export const packServerVariants = [
  PacksStatus,
  loose('pack-approve-result', { requestId, ok: z.boolean(), error: optionalError }),
] as const;
