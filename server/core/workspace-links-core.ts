import path from 'node:path';
import { CHANGE_MAP_LIST_CAP, changeMapFactId } from '../../shared/contracts/change-map.ts';
import type { CrossRepoLink } from '../../shared/contracts/change-map.ts';
import { isRecord } from './change-map-core.ts';

export interface PackageManifest {
  name: string | null;
  dependencySpecs: Record<string, string>;
}

export interface RepoPackageFacts {
  repoName: string;
  manifests: { path: string; manifest: PackageManifest }[];
  importersByPackage: Map<string, string[]>;
  changedPaths: string[];
}

export function readPackageManifest(text: string | null): PackageManifest | null {
  if (text === null) return null;
  try {
    const manifest: unknown = JSON.parse(text);
    if (!isRecord(manifest)) return null;
    const dependencies: [string, string][] = [];
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const group = manifest[field];
      if (!isRecord(group)) continue;
      for (const [packageName, spec] of Object.entries(group)) {
        if (typeof spec === 'string') dependencies.push([packageName, spec]);
      }
    }
    return {
      name: typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : null,
      dependencySpecs: Object.fromEntries(dependencies),
    };
  } catch {
    return null;
  }
}

export function bareSpecifierPackage(specifier: string): string | null {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('#') || specifier.startsWith('/') || specifier.startsWith('\\')) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(specifier)) return null;
  if (specifier.includes('\\') || specifier.includes('?') || specifier.includes('#')) return null;
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) {
    if (!segments[0] || !segments[1]) return null;
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0] || null;
}

export function isLocalLinkSpec(spec: string): boolean {
  return ['file:', 'link:', 'workspace:', 'portal:'].some((prefix) => spec.startsWith(prefix));
}

export function indexImportersByPackage(specifiersByPath: Map<string, string[]>): Map<string, string[]> {
  const importerPathsByPackage = new Map<string, Set<string>>();
  for (const [importerPath, specifiers] of specifiersByPath) {
    if (importerPath.endsWith('.py')) continue;
    for (const specifier of specifiers) {
      const packageName = bareSpecifierPackage(specifier);
      if (!packageName) continue;
      const paths = importerPathsByPackage.get(packageName) ?? new Set<string>();
      paths.add(importerPath);
      importerPathsByPackage.set(packageName, paths);
    }
  }
  return new Map([...importerPathsByPackage].map(([packageName, paths]) => [packageName, [...paths].sort()]));
}

function changedPathCountsByDir(changedPaths: string[]): Map<string, number> {
  const counts = new Map<string, number>([['', changedPaths.length]]);
  for (const changedPath of changedPaths) {
    let directory = path.posix.dirname(changedPath);
    while (directory !== '.') {
      counts.set(directory, (counts.get(directory) ?? 0) + 1);
      directory = path.posix.dirname(directory);
    }
  }
  return counts;
}

export function computeCrossRepoLinks(repos: RepoPackageFacts[]): Map<string, CrossRepoLink[]> {
  const linksByConsumer = new Map<string, CrossRepoLink[]>();
  if (repos.length < 2) return linksByConsumer;

  const providersByPackage = new Map<string, { repoName: string; packageDir: string; changedPathCount: number }[]>();
  for (const repo of repos) {
    const changedCounts = changedPathCountsByDir(repo.changedPaths);
    const firstManifestByPackage = new Map<string, string>();
    for (const { path: manifestPath, manifest } of repo.manifests) {
      if (!manifest.name) continue;
      const previousPath = firstManifestByPackage.get(manifest.name);
      if (previousPath !== undefined && previousPath <= manifestPath) continue;
      firstManifestByPackage.set(manifest.name, manifestPath);
    }
    for (const [packageName, manifestPath] of firstManifestByPackage) {
      const directory = path.posix.dirname(manifestPath);
      const packageDir = directory === '.' ? '' : directory;
      const providers = providersByPackage.get(packageName) ?? [];
      providers.push({ repoName: repo.repoName, packageDir, changedPathCount: changedCounts.get(packageDir) ?? 0 });
      providersByPackage.set(packageName, providers);
    }
  }

  for (const consumer of repos) {
    const firstDeclarationByPackage = new Map<string, { path: string; spec: string }>();
    for (const { path: manifestPath, manifest } of consumer.manifests) {
      for (const [packageName, spec] of Object.entries(manifest.dependencySpecs)) {
        const previous = firstDeclarationByPackage.get(packageName);
        if (previous && previous.path <= manifestPath) continue;
        firstDeclarationByPackage.set(packageName, { path: manifestPath, spec });
      }
    }
    const changedPaths = new Set(consumer.changedPaths);
    const links: CrossRepoLink[] = [];
    for (const [packageName, declaration] of firstDeclarationByPackage) {
      const importers = consumer.importersByPackage.get(packageName) ?? [];
      const changedImporters = importers.filter((importerPath) => changedPaths.has(importerPath));
      const unchangedImporters = importers.filter((importerPath) => !changedPaths.has(importerPath));
      const changedImporterCount = changedImporters.length;
      for (const provider of providersByPackage.get(packageName) ?? []) {
        if (provider.repoName === consumer.repoName) continue;
        if (provider.changedPathCount === 0 && changedImporterCount === 0) continue;
        links.push({
          factId: changeMapFactId('link', consumer.repoName, provider.repoName, packageName),
          providerRepo: provider.repoName,
          packageName,
          packageDir: provider.packageDir,
          consumerManifest: declaration.path,
          versionSpec: declaration.spec,
          isLocalLink: isLocalLinkSpec(declaration.spec),
          providerChangedPathCount: provider.changedPathCount,
          importers: [...changedImporters, ...unchangedImporters].slice(0, CHANGE_MAP_LIST_CAP),
          importerCount: importers.length,
          changedImporterCount,
        });
      }
    }
    links.sort((left, right) => {
      if (left.factId < right.factId) return -1;
      if (left.factId > right.factId) return 1;
      return 0;
    });
    linksByConsumer.set(consumer.repoName, links);
  }
  return linksByConsumer;
}
