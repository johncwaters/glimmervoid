export const HOST_SCRATCH_PREFIXES = [
  'coherence-adopt-npm-',
  'coherence-adopt-',
  'coherence-check-',
  'coherence-readings-',
  'coherence-regulate-',
  'check-',
  'glimmervoid-lane-settings-',
  'glimmervoid-lane-coherence-bin-',
] as const;

export type HostScratchPrefix = (typeof HOST_SCRATCH_PREFIXES)[number];

const MKDTEMP_SUFFIX = /^[A-Za-z0-9]{6}$/;

function isListedScratchName(folderName: string, listedPrefixes: readonly string[]): boolean {
  return listedPrefixes.some((prefix) => folderName.startsWith(prefix) && MKDTEMP_SUFFIX.test(folderName.slice(prefix.length)));
}

export function decideOrphanedScratchFolders(folderNames: readonly string[], listedPrefixes: readonly string[], folderNamesCreatedByThisProcess: ReadonlySet<string>): string[] {
  return folderNames.filter((folderName) => isListedScratchName(folderName, listedPrefixes) && !folderNamesCreatedByThisProcess.has(folderName));
}
