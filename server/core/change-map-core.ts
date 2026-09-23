import { changeMapFactId } from '../../shared/contracts/change-map.ts';
import type { ChangedFile, ChangedFileStatus } from '../../shared/contracts/change-map.ts';

const STATUS_BY_LETTER: Record<string, ChangedFileStatus> = {
  A: 'added',
  C: 'added',
  M: 'modified',
  T: 'modified',
  D: 'deleted',
  R: 'renamed',
  '?': 'untracked',
};

export const SOURCE_EXTENSIONS = Object.freeze(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.mts', '.cts']);

export function isSourcePath(repoPath: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => repoPath.endsWith(extension));
}

export function isAgentsDocPath(repoPath: string): boolean {
  return repoPath === 'AGENTS.md' || repoPath.endsWith('/AGENTS.md');
}

export function parseNameStatus({ repoName, nameStatusText, isCommitted }: {
  repoName: string;
  nameStatusText: string;
  isCommitted: boolean;
}): ChangedFile[] {
  const files: ChangedFile[] = [];
  const fields = nameStatusText.split(String.fromCharCode(0));
  let fieldIndex = 0;
  while (fieldIndex < fields.length) {
    const statusCode = fields[fieldIndex];
    fieldIndex++;
    if (!statusCode) continue;
    const statusLetter = statusCode.charAt(0);
    const isTwoPathRecord = statusLetter === 'R' || statusLetter === 'C';
    const firstPath = fields[fieldIndex] ?? '';
    const secondPath = isTwoPathRecord ? fields[fieldIndex + 1] ?? '' : '';
    fieldIndex += isTwoPathRecord ? 2 : 1;
    const status = STATUS_BY_LETTER[statusLetter];
    if (!status || !firstPath || (isTwoPathRecord && !secondPath)) continue;
    const isRename = status === 'renamed';
    const currentPath = isTwoPathRecord ? secondPath : firstPath;
    files.push({
      factId: changeMapFactId('file', repoName, currentPath),
      path: currentPath,
      ...(isRename ? { previousPath: firstPath } : {}),
      status,
      isCommitted,
    });
  }
  return files;
}

export function mergeChangedFiles(committedFiles: ChangedFile[], uncommittedFiles: ChangedFile[]): ChangedFile[] {
  const fileByPath = new Map<string, ChangedFile>();
  for (const file of committedFiles) fileByPath.set(file.path, file);
  for (const file of uncommittedFiles) {
    const committedFile = fileByPath.get(file.path);
    const keepsCommittedIdentity = committedFile && file.status === 'modified';
    fileByPath.set(file.path, keepsCommittedIdentity ? { ...committedFile, isCommitted: false } : file);
  }
  return [...fileByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

export function presentPaths(files: ChangedFile[]): string[] {
  return files.filter((file) => file.status !== 'deleted').map((file) => file.path);
}

export function parseNulSeparatedPaths(text: string): string[] {
  return text.split(String.fromCharCode(0)).filter(Boolean);
}

export function readImportsMap(packageJsonText: string | null): Record<string, string> {
  if (!packageJsonText) return {};
  try {
    const parsed: unknown = JSON.parse(packageJsonText);
    if (!parsed || typeof parsed !== 'object' || !('imports' in parsed)) return {};
    const imports = parsed.imports;
    if (!imports || typeof imports !== 'object') return {};
    const importsMap: Record<string, string> = {};
    for (const [alias, target] of Object.entries(imports)) {
      if (typeof target === 'string') importsMap[alias] = target;
    }
    return importsMap;
  } catch {
    return {};
  }
}

