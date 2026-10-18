export const HOST_SCRATCH_PREFIXES = [
  'coherence-adopt-npm-',
  'coherence-adopt-',
  'coherence-check-',
  'coherence-readings-',
  'coherence-regulate-',
  'check-',
  'glimmervoid-factory-review-',
  'glimmervoid-factory-index-',
  'glimmervoid-factory-rehearsal-',
  'glimmervoid-lane-settings-',
  'glimmervoid-lane-coherence-bin-',
] as const;

export type HostScratchPrefix = (typeof HOST_SCRATCH_PREFIXES)[number];

const MKDTEMP_SUFFIX = /^[A-Za-z0-9]{6}$/;

function isListedScratchName(folderName: string): boolean {
  return HOST_SCRATCH_PREFIXES.some((prefix) => folderName.startsWith(prefix) && MKDTEMP_SUFFIX.test(folderName.slice(prefix.length)));
}

export function decideOrphanedScratchFolders(folderNames: readonly string[], folderNamesCreatedByThisProcess: ReadonlySet<string>): string[] {
  return folderNames.filter((folderName) => isListedScratchName(folderName) && !folderNamesCreatedByThisProcess.has(folderName));
}
