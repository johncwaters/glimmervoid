import { z } from 'zod';

export const CODEMAP_TARGET_MAX_CHARS = 1000;
export const CODEMAP_IMPACT_MAX_PATHS = 200;

const CodemapTarget = z.string({ error: 'target must be a string' })
  .min(1, { error: 'target must not be empty' })
  .max(CODEMAP_TARGET_MAX_CHARS, { error: `target must be at most ${CODEMAP_TARGET_MAX_CHARS} characters` });

const CODEMAP_STATES = ['current', 'behind', 'failed'] as const;
export const CODEMAP_OVERLAY_LAYERS = ['session', 'spec', 'none'] as const;
export const CODEMAP_EXPORT_KINDS = ['lint', 'map'] as const;
export type CodemapExportKind = (typeof CODEMAP_EXPORT_KINDS)[number];
export const CODEMAP_SPEC_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

export const CodemapStatus = z.strictObject({
  sha: z.string().nullable(),
  mainlineSha: z.string().nullable(),
  state: z.enum(CODEMAP_STATES),
  reason: z.string().nullable(),
});
export type CodemapStatus = z.infer<typeof CodemapStatus>;

export const CodemapExtract = z.strictObject({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  paths: z.array(z.string()),
  importerIndexes: z.instanceof(Int32Array),
  importedIndexes: z.instanceof(Int32Array),
  typeOnlyEdges: z.instanceof(Uint8Array),
  specifiersByIndex: z.array(z.array(z.string())),
  typeOnlySpecifiersByIndex: z.array(z.array(z.string())),
  outsideGraphImportsByIndex: z.array(z.array(z.strictObject({ specifier: z.string(), targetPath: z.string().nullable() }))),
  exportedNamesByIndex: z.array(z.array(z.string())),
  skippedPaths: z.array(z.string()),
});
export type CodemapExtract = z.infer<typeof CodemapExtract>;

export const CodemapExtractBase = CodemapExtract.pick({ sha: true, paths: true, specifiersByIndex: true, typeOnlySpecifiersByIndex: true, exportedNamesByIndex: true });
export type CodemapExtractBase = z.infer<typeof CodemapExtractBase>;

const CodemapModuleName = z.string({ error: 'a module must be a string' }).min(1, { error: 'a module must not be empty' }).max(CODEMAP_TARGET_MAX_CHARS);

const CodemapModuleEdge = z.strictObject({ from: CodemapModuleName, to: CodemapModuleName });
export type CodemapModuleEdge = z.infer<typeof CodemapModuleEdge>;

export const CODEMAP_ALLOW_REASON_MAX_CHARS = 500;

const CodemapAllowEntry = z.discriminatedUnion('origin', [
  z.strictObject({ from: CodemapModuleName, to: CodemapModuleName, origin: z.literal('seeded') }),
  z.strictObject({ from: CodemapModuleName, to: CodemapModuleName, origin: z.literal('allowed'), reason: z.string().min(1).max(CODEMAP_ALLOW_REASON_MAX_CHARS), date: z.iso.date(), landed: z.boolean() }),
]);

export type CodemapAllowEntry = z.infer<typeof CodemapAllowEntry>;

export const CODEMAP_SETUP_VERSION = 1;

export const CodemapSetup = z.strictObject({
  version: z.literal(CODEMAP_SETUP_VERSION),
  repo: z.string().min(1),
  gate: z.boolean(),
  modules: z.array(CodemapModuleName),
  allow: z.array(CodemapAllowEntry),
  exports: z.array(z.enum(CODEMAP_EXPORT_KINDS)),
});
export type CodemapSetup = z.infer<typeof CodemapSetup>;

const DesignSpecUnit = z.object({ kind: z.literal('unit'), id: z.string().min(1).max(40), title: z.string().min(1), changes: z.array(z.string()) });
export type DesignSpecUnit = z.infer<typeof DesignSpecUnit>;

export const DesignSpecForMap = z.object({
  repoRoot: z.string().optional(),
  nodes: z.array(z.looseObject({ kind: z.string() })),
  edges: z.array(z.looseObject({ from: z.string(), kind: z.string(), to: z.string() })),
}).transform((spec, context) => {
  const units = z.array(DesignSpecUnit).safeParse(spec.nodes.filter((node) => node.kind === 'unit'));
  if (!units.success) {
    context.addIssue({ code: 'custom', message: `a unit node is malformed: ${units.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}` });
    return z.NEVER;
  }
  const repeatedUnitIds = units.data.map((unit) => unit.id).filter((id, index, ids) => ids.indexOf(id) !== index);
  if (repeatedUnitIds.length > 0) {
    context.addIssue({ code: 'custom', message: `unit ids repeat: ${[...new Set(repeatedUnitIds)].join(', ')}` });
    return z.NEVER;
  }
  const dependsOnByKey = new Map(spec.edges.filter((edge) => edge.kind === 'dependsOn').map(({ from, to }) => [`${from}\n${to}`, { from, to }]));
  const dependsOn = [...dependsOnByKey.values()];
  return { repoRoot: spec.repoRoot ?? null, units: units.data, dependsOn };
});
export type DesignSpecForMap = z.infer<typeof DesignSpecForMap>;

export const AgentCodemapRequest = z.discriminatedUnion('sub', [
  z.strictObject({ sub: z.literal('map') }),
  z.strictObject({ sub: z.literal('check') }),
  z.strictObject({ sub: z.literal('shrink') }),
  z.strictObject({ sub: z.literal('export'), kind: z.enum(CODEMAP_EXPORT_KINDS, { error: `kind must be one of ${CODEMAP_EXPORT_KINDS.join(', ')}` }) }),
  z.strictObject({ sub: z.literal('allow'), from: CodemapModuleName, to: CodemapModuleName }),
  z.strictObject({ sub: z.literal('where'), target: CodemapTarget }),
  z.strictObject({ sub: z.literal('overlay'), layer: z.enum(CODEMAP_OVERLAY_LAYERS, { error: `layer must be one of ${CODEMAP_OVERLAY_LAYERS.join(', ')}` }), id: CodemapTarget.optional() }),
  z.strictObject({ sub: z.literal('impact'), paths: z.array(CodemapTarget).min(1, { error: 'impact needs at least one path' }).max(CODEMAP_IMPACT_MAX_PATHS, { error: `impact takes at most ${CODEMAP_IMPACT_MAX_PATHS} paths` }) }),
]);
export type AgentCodemapRequest = z.infer<typeof AgentCodemapRequest>;

export const AgentCodemapReply = z.strictObject({
  ok: z.literal(true),
  text: z.string(),
  status: CodemapStatus,
});
export type AgentCodemapReply = z.infer<typeof AgentCodemapReply>;
