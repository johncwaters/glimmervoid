import { z } from 'zod';
import { PrFlowPendingApproval } from '../pr-flows.ts';
import { ThemePalette } from '../theme-palette.ts';
import { PackBridgeTopic, PackName, PackPanelAct, PackSourceSlug, PackStoreData, PackStoreKey, PackStoreValue, ProviderStatus } from '../pack-bridge.ts';
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
  statusUrls: z.array(z.string()).default([]),
  agent: z.strictObject({
    context: z.strictObject({ path: z.string(), text: z.string() }).nullable(),
    skills: z.array(z.strictObject({ name: z.string(), path: z.string(), text: z.string() })),
  }).nullable().default(null),
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

export const PackSourceRow = z.strictObject({
  url: z.string(),
  slug: PackSourceSlug,
  dir: z.string(),
  packs: z.array(z.strictObject({ name: z.string(), dir: z.string(), isEnabled: z.boolean() })),
  error: z.string().nullable(),
});
export type PackSourceRow = z.infer<typeof PackSourceRow>;

export const PacksStatus = loose('packs-status', {
  packs: z.array(PackRow), sources: z.array(PackSourceRow).default([]), themes: z.array(ApprovedPackTheme), panels: z.array(ApprovedPackPanel), launchers: z.array(ApprovedPackLauncher).default([]), providers: z.array(ProviderStatus).default([]), warnings: z.array(z.string()),
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
  loose('pack-source-add', { requestId, url: z.string().trim().min(1).max(500) }).describe('Clone a git pack source; its packs stay off until enabled one by one'),
  loose('pack-source-update', { requestId, slug: PackSourceSlug }).describe('Pull a pack source and reinstall its enabled packs, which then wait for approval again if they changed'),
  loose('pack-source-remove', { requestId, slug: PackSourceSlug }).describe('Delete a pack source clone and the packs enabled from it'),
  loose('pack-source-enable', { requestId, slug: PackSourceSlug, pack: PackName, isEnabled: z.boolean() }).describe('Install one pack from a source, unapproved, or remove that install'),
] as const;

export const packServerVariants = [
  PacksStatus,
  loose('pack-approve-result', { requestId, ok: z.boolean(), error: optionalError }),
  loose('pack-data-result', { requestId, ok: z.boolean(), data: PackStoreData.optional(), error: optionalError }),
  loose('pack-session-send-result', { requestId, ok: z.boolean(), error: optionalError }),
  loose('pack-source-result', { requestId, ok: z.boolean(), text: z.string().optional(), error: optionalError }),
] as const;
