import path from 'node:path';

export function caseFoldedPathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

export function equalsIgnoringCaseOnWindows(a: string, b: string): boolean {
  return caseFoldedPathKey(a) === caseFoldedPathKey(b);
}

export function isPathInside(
  parent: string,
  child: string,
  { allowEqual = true, foldCase = false }: { allowEqual?: boolean; foldCase?: boolean } = {},
): boolean {
  if (!parent || !child) return false;
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  const from = foldCase ? resolvedParent.toLowerCase() : resolvedParent;
  const to = foldCase ? resolvedChild.toLowerCase() : resolvedChild;
  const relative = path.relative(from, to);
  if (relative === '') return allowEqual;
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

export function safePathSegment(value: unknown): string {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '') || '_';
}

export function sanitizeWorktreeName(value: unknown): string {
  return String(value || '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
}
