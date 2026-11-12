import { z } from 'zod';
import { PrFlowPendingApproval } from '../pr-flows.ts';
import { ThemePalette } from '../theme-palette.ts';
import { PackBridgeTopic, PackName, PackPanelAct, PackStoreData, PackStoreKey, PackStoreValue } from '../pack-bridge.ts';
import { PackSessionStart } from '../pack-launch.ts';
import { loose, optionalError, requestId, sessionId } from './control-fields.ts';

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
  launchers: z.array(z.strictObject({ id: z.string(), label: z.string(), project: z.string(), agent: z.string(), model: z.string().nullable(), effort: z.string().nullable(), prompt: z.string(), schedule: z.string().nullable() })),
  sessions: z.strictObject({ dangerouslySkipPermissions: z.boolean(), saneYolo: z.boolean().optional() }).nullable(),
  errors: z.array(z.string()),
});
export type PackRow = z.infer<typeof PackRow>;

const ApprovedPackTheme = z.strictObject({ id: z.string(), palette: ThemePalette });

const ApprovedPackPanel = z.strictObject({
  viewId: z.string(), id: z.string(), pack: z.string(), label: z.string(), entryUrl: z.string(), iconUrl: z.string().nullable(), reads: z.array(PackBridgeTopic), acts: z.array(PackPanelAct),
});

const ApprovedPackLauncher = z.strictObject({
  pack: z.string(), id: z.string(), label: z.string(), agent: z.string(), model: z.string().nullable(), effort: z.string().nullable(), project: z.string(), disabledReason: z.string().nullable(),
});
export type ApprovedPackLauncher = z.infer<typeof ApprovedPackLauncher>;

export const PacksStatus = loose('packs-status', {
  packs: z.array(PackRow), themes: z.array(ApprovedPackTheme), panels: z.array(ApprovedPackPanel), launchers: z.array(ApprovedPackLauncher).default([]), warnings: z.array(z.string()),
});
export type PacksStatus = z.infer<typeof PacksStatus>;

export const PackApproveRequest = z.strictObject({ fingerprint: z.string().min(1).max(128) });

const PackDataRequest = { requestId, pack: PackName };

const PackPanelRequest = { requestId, pack: PackName, panelId: z.string().min(1).max(40) };

export const packClientVariants = [
  loose('pack-approve', { ...PackApproveRequest.shape, requestId }),
  loose('pack-data-get', PackDataRequest),
  loose('pack-data-set', { ...PackDataRequest, key: PackStoreKey, value: PackStoreValue }),
  loose('pack-launch', { requestId, pack: PackName, launcherId: z.string().min(1).max(40) }),
  loose('pack-session-start', { ...PackPanelRequest, ...PackSessionStart.shape }).describe('Start a session from a panel that lists sessions under acts; the reply is add-session-result'),
  loose('pack-session-send', { ...PackPanelRequest, id: sessionId.describe('The live session to type into, from the sessions topic'), text: z.string().trim().min(1).max(4000).describe('Typed into the session and submitted') })
    .describe('Type text into a live session from a panel that lists sessions under acts; the reply is pack-session-send-result'),
] as const;

export const packServerVariants = [
  PacksStatus,
  loose('pack-approve-result', { requestId, ok: z.boolean(), error: optionalError }),
  loose('pack-data-result', { requestId, ok: z.boolean(), data: PackStoreData.optional(), error: optionalError }),
  loose('pack-session-send-result', { requestId, ok: z.boolean(), error: optionalError }),
] as const;
