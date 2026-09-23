import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANGE_MAP_LIST_CAP, changeMapFactId } from '../shared/contracts/change-map.ts';
import {
  bareSpecifierPackage, computeCrossRepoLinks, indexImportersByPackage, isLocalLinkSpec, readPackageManifest,
} from '../server/core/workspace-links-core.ts';
import type { RepoPackageFacts } from '../server/core/workspace-links-core.ts';

test('package manifests merge string dependency specs and reject malformed roots', () => {
  assert.deepEqual(readPackageManifest(JSON.stringify({
    name: 'consumer',
    dependencies: { shared: '^1', ignored: 3 },
    devDependencies: { shared: 'file:../shared', dev: '*' },
    peerDependencies: { peer: 'workspace:*' },
    optionalDependencies: { optional: 'portal:../optional' },
  })), {
    name: 'consumer',
    dependencySpecs: { shared: 'file:../shared', dev: '*', peer: 'workspace:*', optional: 'portal:../optional' },
  });
  assert.equal(readPackageManifest(null), null);
  assert.equal(readPackageManifest('{'), null);
  assert.equal(readPackageManifest('[]'), null);
  assert.equal(readPackageManifest('null'), null);
  assert.deepEqual(readPackageManifest('{}'), { name: null, dependencySpecs: {} });
});

test('bare specifiers keep the package name and local link prefixes are recognized', () => {
  assert.equal(bareSpecifierPackage('@scope/name/sub'), '@scope/name');
  assert.equal(bareSpecifierPackage('name/sub'), 'name');
  for (const specifier of ['', './local', '../local', '#alias', 'node:fs', '/absolute', 'https://host/name', 'C:/absolute']) {
    assert.equal(bareSpecifierPackage(specifier), null);
  }
  for (const spec of ['file:../lib', 'link:../lib', 'workspace:*', 'portal:../lib']) assert.equal(isLocalLinkSpec(spec), true);
  assert.equal(isLocalLinkSpec('^1.0.0'), false);
});

test('importer index deduplicates paths across subpath imports and sorts them', () => {
  const index = indexImportersByPackage(new Map([
    ['z.ts', ['shared/sub', 'shared', './local']],
    ['a.ts', ['shared', '@scope/name/sub', 'node:fs']],
    ['posthog/models/user.py', ['shared', 'posthog.models']],
  ]));
  assert.deepEqual(index.get('shared'), ['a.ts', 'z.ts']);
  assert.deepEqual(index.get('@scope/name'), ['a.ts']);
  assert.equal(index.has('node:fs'), false);
  assert.equal(index.has('posthog.models'), false);
});

function repoFacts(repoName: string, manifests: RepoPackageFacts['manifests'], changedPaths: string[] = [], importersByPackage = new Map<string, string[]>()): RepoPackageFacts {
  return { repoName, manifests, changedPaths, importersByPackage };
}

test('links live on consumers and count changes inside the selected provider package', () => {
  const provider = repoFacts('lib', [
    { path: 'z/package.json', manifest: { name: 'shared-lib', dependencySpecs: {} } },
    { path: 'packages/shared/package.json', manifest: { name: 'shared-lib', dependencySpecs: {} } },
  ], ['packages/shared/src/index.ts', 'z/index.ts', 'README.md']);
  const importers = Array.from({ length: CHANGE_MAP_LIST_CAP + 2 }, (_, index) => `src/import-${String(index).padStart(2, '0')}.ts`);
  const consumer = repoFacts('app', [
    { path: 'z/package.json', manifest: { name: null, dependencySpecs: { 'shared-lib': '^2' } } },
    { path: 'a/package.json', manifest: { name: null, dependencySpecs: { 'shared-lib': 'file:../lib' } } },
  ], [importers[0], importers.at(-1) ?? ''], new Map([['shared-lib', importers]]));
  const links = computeCrossRepoLinks([provider, consumer]);
  assert.deepEqual(links.get('lib'), []);
  assert.deepEqual(links.get('app'), [{
    factId: changeMapFactId('link', 'app', 'lib', 'shared-lib'),
    providerRepo: 'lib', packageName: 'shared-lib', packageDir: 'packages/shared',
    consumerManifest: 'a/package.json', versionSpec: 'file:../lib', isLocalLink: true,
    providerChangedPathCount: 1, importers: [importers[0], importers.at(-1), ...importers.slice(1, CHANGE_MAP_LIST_CAP - 1)],
    importerCount: CHANGE_MAP_LIST_CAP + 2, changedImporterCount: 2,
  }]);
});

test('duplicate providers each link and unchanged pairs do not link', () => {
  const manifest = { name: 'shared-lib', dependencySpecs: {} };
  const dependency = { name: null, dependencySpecs: { 'shared-lib': '^1' } };
  const consumer = repoFacts('app', [{ path: 'package.json', manifest: dependency }], [], new Map([['shared-lib', ['src/use.ts']]]));
  const first = repoFacts('first', [{ path: 'package.json', manifest }], ['src/index.ts']);
  const second = repoFacts('second', [{ path: 'package.json', manifest }], []);
  assert.deepEqual(computeCrossRepoLinks([consumer, first, second]).get('app')?.map((link) => link.providerRepo), ['first']);
  consumer.changedPaths.push('src/use.ts');
  assert.deepEqual(computeCrossRepoLinks([consumer, first, second]).get('app')?.map((link) => link.providerRepo), ['first', 'second']);
  assert.deepEqual(computeCrossRepoLinks([consumer]), new Map());
});

test('capped importers lead with changed importers even when they sort past the cap', () => {
  const provider = repoFacts('lib', [{ path: 'package.json', manifest: { name: 'shared-lib', dependencySpecs: {} } }]);
  const importers = [...Array.from({ length: 29 }, (_, index) => `src/import-${String(index).padStart(2, '0')}.ts`), 'src/zeta.ts'];
  const consumer = repoFacts('app', [
    { path: 'package.json', manifest: { name: null, dependencySpecs: { 'shared-lib': '^1' } } },
  ], ['src/zeta.ts'], new Map([['shared-lib', importers]]));
  const [link] = computeCrossRepoLinks([provider, consumer]).get('app') ?? [];
  assert.equal(link?.changedImporterCount, 1);
  assert.equal(link?.importerCount, 30);
  assert.equal(link?.importers.length, CHANGE_MAP_LIST_CAP);
  assert.deepEqual(link?.importers, ['src/zeta.ts', ...importers.slice(0, CHANGE_MAP_LIST_CAP - 1)]);
});
