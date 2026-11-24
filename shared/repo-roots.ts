export function withRepoRootsAdded(repoRoots: readonly string[], addedRoots: readonly string[]): string[] | null {
  const nextRoots = [...repoRoots];
  for (const addedRoot of addedRoots) {
    if (!nextRoots.includes(addedRoot)) nextRoots.push(addedRoot);
  }
  return nextRoots.length === repoRoots.length ? null : nextRoots;
}
