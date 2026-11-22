import path from 'node:path';

interface ManifestPackage {
  manifestName: string;
  name: string;
  manifestDirectory: string;
  sourceDirectory: string;
  rootFile: string | null;
}

export interface ManifestPackageIndex {
  packagesByName: Map<string, ManifestPackage[]>;
  packageByManifestDirectory: Map<string, ManifestPackage>;
  maxNameSegmentsByManifest: Map<string, number>;
}

type PackageReader = (manifestText: string, manifestDirectory: string) => ManifestPackage[];

const GO_MODULE_DIRECTIVE = /^\s*module\s+"?([^\s"]+)"?/m;
const TOML_SECTION_HEADER = /^\s*\[\[?([^\]]*)\]\]?\s*$/;
const TOML_STRING_KEY = /^\s*(name|path)\s*=\s*"([^"]*)"/;
const PUBSPEC_NAME = /^name:\s*["']?([A-Za-z_]\w*)/m;
const SWIFT_TARGET_CALL = /\.(target|executableTarget|testTarget|macro)\s*\(\s*name\s*:\s*"([^"]+)"/g;
const SWIFT_TARGET_PATH = /\bpath\s*:\s*"([^"]+)"/;
const PHP_NAMESPACE_SEPARATOR = '\\';
const MAX_PACKAGES_PER_MANIFEST = 256;
const MAX_PACKAGES_PER_NAME = 16;

function withoutTrailingSlash(repoPath: string): string {
  const normalizedPath = path.posix.normalize(repoPath);
  return normalizedPath.length > 1 && normalizedPath.endsWith('/') ? normalizedPath.slice(0, -1) : normalizedPath;
}

function packageAt(manifestName: string, manifestDirectory: string, name: string, sourceDirectory: string, rootFile: string | null = null): ManifestPackage {
  return { manifestName, name, manifestDirectory, sourceDirectory: withoutTrailingSlash(sourceDirectory), rootFile: rootFile && withoutTrailingSlash(rootFile) };
}

function readGoModule(manifestText: string, manifestDirectory: string): ManifestPackage[] {
  const modulePath = GO_MODULE_DIRECTIVE.exec(manifestText)?.[1];
  return modulePath ? [packageAt('go.mod', manifestDirectory, modulePath, manifestDirectory)] : [];
}

function readCargoCrate(manifestText: string, manifestDirectory: string): ManifestPackage[] {
  const valuesBySection = new Map<string, Map<string, string>>();
  let section = '';
  for (const line of manifestText.split('\n')) {
    const header = TOML_SECTION_HEADER.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const keyValue = TOML_STRING_KEY.exec(line);
    if (!keyValue || (section !== 'package' && section !== 'lib')) continue;
    const sectionValues = valuesBySection.get(section) ?? new Map<string, string>();
    if (!sectionValues.has(keyValue[1])) sectionValues.set(keyValue[1], keyValue[2]);
    valuesBySection.set(section, sectionValues);
  }
  const crateName = valuesBySection.get('lib')?.get('name') ?? valuesBySection.get('package')?.get('name');
  if (!crateName) return [];
  const rootFile = path.posix.join(manifestDirectory, valuesBySection.get('lib')?.get('path') ?? 'src/lib.rs');
  return [packageAt('Cargo.toml', manifestDirectory, crateName.replaceAll('-', '_'), path.posix.dirname(rootFile), rootFile)];
}

function readPubPackage(manifestText: string, manifestDirectory: string): ManifestPackage[] {
  const packageName = PUBSPEC_NAME.exec(manifestText)?.[1];
  return packageName ? [packageAt('pubspec.yaml', manifestDirectory, packageName, path.posix.join(manifestDirectory, 'lib'))] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsedJsonOf(manifestText: string): unknown {
  try {
    return JSON.parse(manifestText);
  } catch {
    return null;
  }
}

function readComposerAutoload(manifestText: string, manifestDirectory: string): ManifestPackage[] {
  const manifest = parsedJsonOf(manifestText);
  if (!isRecord(manifest)) return [];
  return ['autoload', 'autoload-dev'].flatMap((field) => {
    const autoload = manifest[field];
    const psr4 = isRecord(autoload) ? autoload['psr-4'] : null;
    if (!isRecord(psr4)) return [];
    return Object.entries(psr4).flatMap(([namespacePrefix, directories]) => {
      const namespaceName = namespacePrefix.replace(/^\\+|\\+$/g, '');
      if (!namespaceName) return [];
      return [directories].flat().filter((directory): directory is string => typeof directory === 'string').map((directory) => packageAt('composer.json', manifestDirectory, namespaceName, path.posix.join(manifestDirectory, directory)));
    });
  });
}

function callEndOf(text: string, openParenIndex: number): number {
  let depth = 0;
  for (let index = openParenIndex; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      for (index++; index < text.length && text[index] !== '"'; index++) if (text[index] === '\\') index++;
      continue;
    }
    if (character === '(') depth++;
    if (character === ')') depth--;
    if (depth === 0) return index + 1;
  }
  return text.length;
}

function readSwiftTargets(manifestText: string, manifestDirectory: string): ManifestPackage[] {
  const targets: ManifestPackage[] = [];
  let enclosingCallEnd = 0;
  for (const targetCall of manifestText.matchAll(SWIFT_TARGET_CALL)) {
    if (targetCall.index < enclosingCallEnd) continue;
    const [, targetKind, targetName] = targetCall;
    const openParenIndex = manifestText.indexOf('(', targetCall.index);
    enclosingCallEnd = callEndOf(manifestText, openParenIndex);
    const declaredPath = SWIFT_TARGET_PATH.exec(manifestText.slice(openParenIndex, enclosingCallEnd))?.[1];
    const defaultPath = `${targetKind === 'testTarget' ? 'Tests' : 'Sources'}/${targetName}`;
    targets.push(packageAt('Package.swift', manifestDirectory, targetName, path.posix.join(manifestDirectory, declaredPath ?? defaultPath)));
  }
  return targets;
}

const PACKAGE_READER_BY_MANIFEST: Record<string, PackageReader> = {
  'go.mod': readGoModule,
  'Cargo.toml': readCargoCrate,
  'pubspec.yaml': readPubPackage,
  'composer.json': readComposerAutoload,
  'Package.swift': readSwiftTargets,
};

const NAME_SEPARATOR_BY_MANIFEST: Record<string, string> = { 'go.mod': '/', 'composer.json': PHP_NAMESPACE_SEPARATOR };

function packageKey(manifestName: string, nameOrDirectory: string): string {
  return `${manifestName}\0${nameOrDirectory}`;
}

export function manifestPackageIndexOf(manifestTextByPath: ReadonlyMap<string, string>): ManifestPackageIndex {
  const index: ManifestPackageIndex = { packagesByName: new Map(), packageByManifestDirectory: new Map(), maxNameSegmentsByManifest: new Map() };
  for (const [manifestPath, manifestText] of manifestTextByPath) {
    const manifestName = path.posix.basename(manifestPath);
    const readPackages = PACKAGE_READER_BY_MANIFEST[manifestName];
    if (!readPackages) continue;
    for (const manifestPackage of readPackages(manifestText, path.posix.dirname(manifestPath)).slice(0, MAX_PACKAGES_PER_MANIFEST)) {
      const nameKey = packageKey(manifestName, manifestPackage.name);
      const samePackages = index.packagesByName.get(nameKey) ?? [];
      if (samePackages.length >= MAX_PACKAGES_PER_NAME || samePackages.some((samePackage) => samePackage.sourceDirectory === manifestPackage.sourceDirectory)) continue;
      samePackages.push(manifestPackage);
      index.packagesByName.set(nameKey, samePackages);
      const directoryKey = packageKey(manifestName, manifestPackage.manifestDirectory);
      if (!index.packageByManifestDirectory.has(directoryKey)) index.packageByManifestDirectory.set(directoryKey, manifestPackage);
      const separator = NAME_SEPARATOR_BY_MANIFEST[manifestName];
      const nameSegments = separator ? manifestPackage.name.split(separator).length : 1;
      index.maxNameSegmentsByManifest.set(manifestName, Math.max(index.maxNameSegmentsByManifest.get(manifestName) ?? 0, nameSegments));
    }
  }
  return index;
}

export function packagesOfManifest(index: ManifestPackageIndex, manifestName: string): ManifestPackage[] {
  return [...index.packagesByName.values()].flat().filter((manifestPackage) => manifestPackage.manifestName === manifestName);
}

export function packagesNamed(index: ManifestPackageIndex, manifestName: string, name: string): ManifestPackage[] {
  return index.packagesByName.get(packageKey(manifestName, name)) ?? [];
}

export function nearestPackage(index: ManifestPackageIndex, manifestName: string, fromPath: string): ManifestPackage | null {
  for (let directory = path.posix.dirname(fromPath); ; directory = path.posix.dirname(directory)) {
    const found = index.packageByManifestDirectory.get(packageKey(manifestName, directory));
    if (found) return found;
    if (directory === '.' || directory === '/') return null;
  }
}

interface PrefixMatch {
  manifestPackage: ManifestPackage;
  remainder: string[];
}

export function packagePrefixMatches(index: ManifestPackageIndex, manifestName: string, specifier: string): PrefixMatch[] {
  const separator = NAME_SEPARATOR_BY_MANIFEST[manifestName] ?? '/';
  const maxNameSegments = index.maxNameSegmentsByManifest.get(manifestName) ?? 0;
  const prefixEnds: number[] = [];
  for (let end = specifier.indexOf(separator); end !== -1 && prefixEnds.length < maxNameSegments; end = specifier.indexOf(separator, end + 1)) prefixEnds.push(end);
  if (prefixEnds.length < maxNameSegments) prefixEnds.push(specifier.length);
  return prefixEnds.reverse().flatMap((end) => {
    const remainder = specifier.slice(end + 1);
    return packagesNamed(index, manifestName, specifier.slice(0, end)).map((manifestPackage) => ({ manifestPackage, remainder: remainder ? remainder.split(separator) : [] }));
  });
}
