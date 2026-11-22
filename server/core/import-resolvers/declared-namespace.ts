import path from 'node:path';

interface DeclaredNamespaceIndex {
  filesByName: Map<string, string[]>;
  filesByMemberName: Map<string, string[]>;
}

interface DeclaredNameResolution {
  declaredName: string;
  memberName: string | null;
  memberFiles: readonly string[];
}

const MAX_NAME_SEGMENTS = 64;
const GLOBAL_ALIAS_PREFIX = /^global::/;
const SEGMENT_SEPARATOR = '.';

function appendTo(listByKey: Map<string, string[]>, key: string, value: string): void {
  const values = listByKey.get(key) ?? [];
  values.push(value);
  listByKey.set(key, values);
}

function fileStemOf(repoPath: string): string {
  const basename = path.posix.basename(repoPath);
  const extensionStart = basename.indexOf('.');
  return extensionStart === -1 ? basename : basename.slice(0, extensionStart);
}

function declaredNamespaceIndexOf(declaredNamesByPath: Iterable<readonly [string, readonly string[]]>): DeclaredNamespaceIndex {
  const filesByName = new Map<string, string[]>();
  const filesByMemberName = new Map<string, string[]>();
  for (const [repoPath, declaredNames] of declaredNamesByPath) {
    for (const declaredName of declaredNames) {
      appendTo(filesByName, declaredName, repoPath);
      appendTo(filesByMemberName, `${declaredName}${SEGMENT_SEPARATOR}${fileStemOf(repoPath)}`, repoPath);
    }
  }
  return { filesByName, filesByMemberName };
}

function isWellFormedName(name: string): boolean {
  const segments = name.split(SEGMENT_SEPARATOR);
  return segments.length <= MAX_NAME_SEGMENTS && !segments.includes('');
}

function resolveDeclaredName(index: DeclaredNamespaceIndex, specifier: string): DeclaredNameResolution | null {
  const name = specifier.replace(GLOBAL_ALIAS_PREFIX, '');
  if (!isWellFormedName(name)) return null;
  for (let prefixEnd = name.length; prefixEnd > 0; prefixEnd = name.lastIndexOf(SEGMENT_SEPARATOR, prefixEnd - 1)) {
    const declaredName = name.slice(0, prefixEnd);
    if (!index.filesByName.has(declaredName)) continue;
    if (prefixEnd === name.length) return { declaredName, memberName: null, memberFiles: [] };
    const memberEnd = name.indexOf(SEGMENT_SEPARATOR, prefixEnd + 1);
    const memberName = name.slice(0, memberEnd === -1 ? name.length : memberEnd);
    return { declaredName, memberName, memberFiles: index.filesByMemberName.get(memberName) ?? [] };
  }
  return null;
}

export { declaredNamespaceIndexOf, resolveDeclaredName };
export type { DeclaredNamespaceIndex };
