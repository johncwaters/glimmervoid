import { z } from 'zod';

export const CODEMAP_TARGET_MAX_CHARS = 1000;
export const CODEMAP_IMPACT_MAX_PATHS = 200;

const CodemapTarget = z.string({ error: 'target must be a string' })
  .min(1, { error: 'target must not be empty' })
  .max(CODEMAP_TARGET_MAX_CHARS, { error: `target must be at most ${CODEMAP_TARGET_MAX_CHARS} characters` });

const CODEMAP_STATES = ['current', 'behind', 'failed'] as const;

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
  specifiersByIndex: z.array(z.array(z.string())),
  exportedNamesByIndex: z.array(z.array(z.string())),
  skippedPaths: z.array(z.string()),
});
export type CodemapExtract = z.infer<typeof CodemapExtract>;

export const CodemapExtractBase = CodemapExtract.pick({ sha: true, paths: true, specifiersByIndex: true, exportedNamesByIndex: true });
export type CodemapExtractBase = z.infer<typeof CodemapExtractBase>;

const CodemapModuleName = z.string({ error: 'a module must be a string' }).min(1, { error: 'a module must not be empty' }).max(CODEMAP_TARGET_MAX_CHARS);

const CodemapModuleEdge = z.strictObject({ from: CodemapModuleName, to: CodemapModuleName });
export type CodemapModuleEdge = z.infer<typeof CodemapModuleEdge>;

export const CodemapSetup = z.strictObject({
  repo: z.string().min(1),
  gate: z.boolean(),
  modules: z.array(CodemapModuleName),
  allow: z.array(CodemapModuleEdge),
});
export type CodemapSetup = z.infer<typeof CodemapSetup>;

export const AgentCodemapRequest = z.discriminatedUnion('sub', [
  z.strictObject({ sub: z.literal('map') }),
  z.strictObject({ sub: z.literal('check') }),
  z.strictObject({ sub: z.literal('allow'), from: CodemapModuleName, to: CodemapModuleName }),
  z.strictObject({ sub: z.literal('where'), target: CodemapTarget }),
  z.strictObject({ sub: z.literal('impact'), paths: z.array(CodemapTarget).min(1, { error: 'impact needs at least one path' }).max(CODEMAP_IMPACT_MAX_PATHS, { error: `impact takes at most ${CODEMAP_IMPACT_MAX_PATHS} paths` }) }),
]);
export type AgentCodemapRequest = z.infer<typeof AgentCodemapRequest>;

export const AgentCodemapReply = z.strictObject({
  ok: z.literal(true),
  text: z.string(),
  status: CodemapStatus,
});
export type AgentCodemapReply = z.infer<typeof AgentCodemapReply>;
