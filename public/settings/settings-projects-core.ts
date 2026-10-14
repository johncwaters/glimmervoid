export function unionProjectSelection({ checked = [], stored = [], rendered = [] }: { checked?: string[]; stored?: unknown[]; rendered?: string[] } = {}) {
  const renderedIds = new Set(rendered);
  const selection = [...checked];
  for (const id of stored) {
    if (typeof id !== 'string' || !id.trim()) continue;
    if (renderedIds.has(id) || selection.includes(id)) continue;
    selection.push(id);
  }
  return selection;
}

export function projectSelectionChoices(available: { id: string; name: string }[], selected: readonly string[]) {
  const availableIds = new Set(available.map((project) => project.id));
  const unavailable = [...new Set(selected)].filter((id) => !availableIds.has(id));
  return [...available, ...unavailable.map((id) => ({ id, name: `Unavailable project (${id})` }))];
}

export function includesRepositoryRoot(roots: readonly string[], candidate: string, isCaseInsensitive: boolean): boolean {
  if (!isCaseInsensitive) return roots.includes(candidate);
  return roots.some((root) => root.toLowerCase() === candidate.toLowerCase());
}
