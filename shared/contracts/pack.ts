import { z } from 'zod';
import { PrFlowCommand, PrFlowPackRequires, PrFlowPrAction, PrFlowRule, prFlowRulesJsonSchema } from './pr-flows.ts';

const PACK_SCHEMA_URL = 'https://glimmervoid.dev/schema/pack.v1.json';
export const PACK_FILE_NAME = 'pack.json';

const PackName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, { error: 'a pack name is lowercase letters, digits and dashes, at most 40 characters' });

export const PackHeader = z.strictObject({
  $schema: z.string().optional(),
  name: PackName,
  version: z.number().int().positive(),
  description: z.string().max(500).optional(),
  requires: PrFlowPackRequires.default({ env: [], programs: [] }),
  prFlows: z.unknown().optional(),
  ui: z.unknown().optional(),
});
export type PackHeader = z.infer<typeof PackHeader>;

export const PackPrFlows = z.strictObject({
  prActions: z.array(PrFlowPrAction).default([]),
  sources: z.array(PrFlowCommand).default([]),
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

export type PackSection<Value> = { ok: true; value: Value } | { ok: false; errors: string[] };

export type PackOnDisk = {
  dir: string;
  header: PackHeader;
  fingerprint: string;
  filesByPath: ReadonlyMap<string, Buffer>;
  prFlows: PackSection<PackPrFlows> | null;
  missingRequires: string[];
};

const PackManifestForSchema = PackHeader.extend({ prFlows: PackPrFlows.optional() });

export function packJsonSchemaText(): string {
  return `${JSON.stringify({ $id: PACK_SCHEMA_URL, title: 'Glimmervoid pack', ...prFlowRulesJsonSchema(PackManifestForSchema) }, null, 2)}\n`;
}
