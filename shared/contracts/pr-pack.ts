import { z } from 'zod';
import { PrFlowCommand, PrFlowPackRequires, PrFlowPrAction, PrFlowRule, prFlowRulesJsonSchema } from './pr-flows.ts';

const PR_PACK_SCHEMA_URL = 'https://glimmervoid.dev/schema/pr-pack.v1.json';
export const PR_PACK_FILE_NAME = 'pack.json';

export const PrPack = z.strictObject({
  $schema: z.string().optional(),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, { error: 'a pack name is lowercase letters, digits and dashes, at most 40 characters' }),
  version: z.number().int().positive(),
  description: z.string().max(500).optional(),
  requires: PrFlowPackRequires.default({ env: [], programs: [] }),
  prActions: z.array(PrFlowPrAction).default([]),
  sources: z.array(PrFlowCommand).default([]),
  actions: z.array(PrFlowCommand).default([]),
  rules: z.array(PrFlowRule).default([]),
}).superRefine((pack, context) => {
  for (const kind of ['prActions', 'sources', 'actions'] as const) {
    const seenIds = new Set<string>();
    pack[kind].forEach((command, index) => {
      if (seenIds.has(command.id)) context.addIssue({ code: 'custom', path: [kind, index, 'id'], message: `the id '${command.id}' is already used in ${kind}` });
      seenIds.add(command.id);
    });
  }
});
export type PrPack = z.infer<typeof PrPack>;

export type PrPackOnDisk = { dir: string; pack: PrPack; fingerprint: string; missingRequires: string[] };

export function prPackJsonSchemaText(): string {
  return `${JSON.stringify({ $id: PR_PACK_SCHEMA_URL, title: 'Glimmervoid PR flows pack', ...prFlowRulesJsonSchema(PrPack) }, null, 2)}\n`;
}
