import { z } from 'zod';
import { ThemePalette } from './theme-palette.ts';
import { PackBridgeTopic } from './pack-bridge.ts';
import { PrFlowCommand, PrFlowPackRequires, PrFlowPrAction, PrFlowRule, PrFlowScopedCommand, RepoScope, prFlowRulesJsonSchema } from './pr-flows.ts';

const PACK_SCHEMA_URL = 'https://glimmervoid.dev/schema/pack.v1.json';
export const PACK_FILE_NAME = 'pack.json';

const PackName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, { error: 'a pack name is lowercase letters, digits and dashes, at most 40 characters' });

export const PackHeader = z.strictObject({
  $schema: z.string().optional(),
  name: PackName.describe('Unique among installed packs; a second pack with the same name is refused. Theme and panel ids are scoped to it, so they never clash with another pack'),
  version: z.number().int().positive().describe('Your release number, shown to the operator beside the pack; raise it with each change. Approval follows the files, not this number: any changed file asks again'),
  description: z.string().max(500).optional(),
  requires: PrFlowPackRequires.default({ env: [], programs: [] }),
  prFlows: z.unknown().optional(),
  ui: z.unknown().optional(),
});
export type PackHeader = z.infer<typeof PackHeader>;

export const PackPrFlows = z.strictObject({
  repos: RepoScope.describe('The default owner/name repositories for every prAction, source and rule of this pack that lists no repos of its own; every repository when absent'),
  prActions: z.array(PrFlowPrAction).default([]),
  sources: z.array(PrFlowScopedCommand).default([]),
  actions: z.array(PrFlowCommand).default([]),
  rules: z.array(PrFlowRule).default([]),
}).superRefine((section, context) => {
  for (const kind of ['prActions', 'sources', 'actions'] as const) {
    const seenIds = new Set<string>();
    section[kind].forEach((command, index) => {
      if (seenIds.has(command.id)) context.addIssue({ code: 'custom', path: [kind, index, 'id'], message: `the id '${command.id}' is already used in ${kind}` });
      seenIds.add(command.id);
    });
  }
});
export type PackPrFlows = z.infer<typeof PackPrFlows>;

const PackItemId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, { error: 'an id is lowercase letters, digits and dashes, at most 40 characters' });

const PackFilePath = z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]{1,200}$/, { error: 'a pack file path is relative, inside the pack, and uses letters, digits, dot, dash, underscore and slash' });

export const PackPanel = z.strictObject({
  id: PackItemId,
  label: z.string().trim().min(1).max(24),
  entry: PackFilePath.refine((filePath) => filePath.endsWith('.html'), { error: 'a panel entry is an .html file' }).describe('The HTML page the panel opens, relative to the pack folder'),
  icon: PackFilePath.refine((filePath) => filePath.endsWith('.svg'), { error: 'a panel icon is an .svg file' }).optional(),
  reads: z.array(PackBridgeTopic).default([]).describe('The bridge topics this panel may receive; the operator sees them before approving, and a subscribe for any other topic is ignored'),
});

export const PackUi = z.strictObject({
  themes: z.array(ThemePalette.extend({ id: PackItemId })).max(8).default([]),
  panels: z.array(PackPanel).max(8).default([]),
}).superRefine((section, context) => {
  for (const kind of ['themes', 'panels'] as const) {
    const seenIds = new Set<string>();
    section[kind].forEach((item, index) => {
      if (seenIds.has(item.id)) context.addIssue({ code: 'custom', path: [kind, index, 'id'], message: `the id '${item.id}' is already used in ${kind}` });
      seenIds.add(item.id);
    });
  }
});
export type PackUi = z.infer<typeof PackUi>;

export const PacksState = z.strictObject({ approvedFingerprints: z.array(z.string().min(1)).default([]) });
export type PacksState = z.infer<typeof PacksState>;

export type PackSection<Value> = { ok: true; value: Value } | { ok: false; errors: string[] };

export type PackOnDisk = {
  dir: string;
  header: PackHeader;
  fingerprint: string;
  filesByPath: ReadonlyMap<string, Buffer>;
  prFlows: PackSection<PackPrFlows> | null;
  ui: PackSection<PackUi> | null;
  missingRequires: string[];
};

const PackManifestForSchema = PackHeader.extend({ prFlows: PackPrFlows.optional(), ui: PackUi.optional() });

export function packJsonSchemaText(): string {
  return `${JSON.stringify({ $id: PACK_SCHEMA_URL, title: 'Glimmervoid pack', ...prFlowRulesJsonSchema(PackManifestForSchema) }, null, 2)}\n`;
}
