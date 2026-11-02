import path from 'node:path';

const WILDCARD_SKIPPED_NAME = /production/i;

function namesMatchingWildcard(entry: string, rootEntryNames: readonly string[]): string[] {
  if (entry.includes('/') || entry.includes('\\')) return [];
  return rootEntryNames.filter((name) => path.matchesGlob(name, entry) && !WILDCARD_SKIPPED_NAME.test(name));
}

export function expandShareList(entries: readonly string[], rootEntryNames: readonly string[]): string[] {
  return entries.flatMap((entry) => (entry.includes('*') ? namesMatchingWildcard(entry, rootEntryNames) : [entry]));
}
