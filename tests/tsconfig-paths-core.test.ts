import test from 'node:test';
import assert from 'node:assert/strict';
import { createTsconfigPathsResolver, matchPathPatterns, parseTsconfigJsonc } from '../server/core/tsconfig-paths-core.ts';
import type { TsconfigPaths } from '../server/core/tsconfig-paths-core.ts';

test('JSONC parser removes comments and trailing commas without touching strings', () => {
  const parsed = parseTsconfigJsonc('{\n// note\n"extends":"./tsconfig.build.json",/* note */"compilerOptions":{"baseUrl":"./src", "paths":{"@shared/*":["./shared/*",], "@url":["./https://host//file.ts"],},},}');
  assert.deepEqual(parsed, {
    extendsPath: './tsconfig.build.json',
    baseUrl: './src',
    paths: { '@shared/*': ['./shared/*'], '@url': ['./https://host//file.ts'] },
  });
  assert.equal(parseTsconfigJsonc('{bad'), null);
  assert.equal(parseTsconfigJsonc('[]'), null);
  assert.equal(parseTsconfigJsonc('{"compilerOptions":{}}/*'), null);
  assert.equal(parseTsconfigJsonc('{"extends":"package/tsconfig.json"}')?.extendsPath, null);
});

test('paths matching chooses exact aliases then longest wildcard prefix and target order', () => {
  const patterns = { '@*': ['general/*'], '@shared/*': ['specific/*', 'backup/*'], '@shared/util': ['exact.ts'] };
  assert.deepEqual(matchPathPatterns('@shared/util', patterns), ['exact.ts', 'specific/util', 'backup/util', 'general/shared/util']);
  assert.deepEqual(matchPathPatterns('@shared/other', patterns), ['specific/other', 'backup/other', 'general/shared/other']);
});

test('relative extends inherits paths only when the child declares none and guards cycles', () => {
  const configs = new Map<string, TsconfigPaths>([
    ['tsconfig.json', { extendsPath: './config/base.json', baseUrl: null, paths: null }],
    ['config/base.json', { extendsPath: '../tsconfig.json', baseUrl: '../src', paths: { '@shared/*': ['./shared/*'], '@local': ['./old.ts'] } }],
    ['app/tsconfig.json', { extendsPath: '../config/base.json', baseUrl: null, paths: { '@local': ['./local.ts'] } }],
    ['nested/tsconfig.json', { extendsPath: null, baseUrl: './source', paths: null }],
  ]);
  const targets = createTsconfigPathsResolver(configs);
  assert.deepEqual(targets('src/main.ts', '@shared/util'), ['src/shared/util', 'src/@shared/util']);
  assert.deepEqual(targets('src/main.ts', '@local'), ['src/old.ts', 'src/@local']);
  assert.deepEqual(targets('app/main.ts', '@local'), ['src/local.ts', 'src/@local']);
  assert.deepEqual(targets('app/main.ts', '@shared/util'), ['src/@shared/util']);
  assert.deepEqual(targets('nested/deep/main.ts', 'helper'), ['nested/source/helper']);
  assert.deepEqual(targets('other/main.ts', 'helper'), ['src/helper']);
});

test('a child declaring its own paths replaces every inherited alias', () => {
  const configs = new Map<string, TsconfigPaths>([
    ['tsconfig.base.json', { extendsPath: null, baseUrl: '.', paths: { react: ['shims/react'] } }],
    ['apps/web/tsconfig.json', { extendsPath: '../../tsconfig.base.json', baseUrl: null, paths: { '@app/*': ['apps/web/src/*'] } }],
  ]);
  const targets = createTsconfigPathsResolver(configs);
  assert.deepEqual(targets('apps/web/src/main.ts', 'react'), ['react']);
  assert.deepEqual(targets('apps/web/src/main.ts', '@app/x'), ['apps/web/src/x', '@app/x']);
});

test('an explicit empty paths object clears inherited aliases', () => {
  assert.equal(parseTsconfigJsonc('{"compilerOptions":{}}')?.paths, null);
  assert.deepEqual(parseTsconfigJsonc('{"compilerOptions":{"paths":{}}}')?.paths, {});
  const configs = new Map<string, TsconfigPaths>([
    ['tsconfig.json', { extendsPath: null, baseUrl: null, paths: { '@lib/*': ['lib/*'] } }],
    ['apps/web/tsconfig.json', { extendsPath: '../../tsconfig.json', baseUrl: null, paths: {} }],
  ]);
  const targets = createTsconfigPathsResolver(configs);
  assert.deepEqual(targets('apps/web/main.ts', '@lib/x'), []);
  assert.deepEqual(targets('main.ts', '@lib/x'), ['lib/x']);
});

test('paths declared below an inherited baseUrl resolve against that baseUrl', () => {
  const configs = new Map<string, TsconfigPaths>([
    ['tsconfig.base.json', { extendsPath: null, baseUrl: './src', paths: null }],
    ['apps/web/tsconfig.json', { extendsPath: '../../tsconfig.base.json', baseUrl: null, paths: { '@lib/*': ['lib/*'] } }],
  ]);
  const targets = createTsconfigPathsResolver(configs);
  assert.deepEqual(targets('apps/web/main.ts', '@lib/x'), ['src/lib/x', 'src/@lib/x']);
});

test('inherited paths re-base onto a child baseUrl override', () => {
  const configs = new Map<string, TsconfigPaths>([
    ['tsconfig.base.json', { extendsPath: null, baseUrl: null, paths: { '@lib/*': ['lib/*'] } }],
    ['apps/web/tsconfig.json', { extendsPath: '../../tsconfig.base.json', baseUrl: './source', paths: null }],
  ]);
  const targets = createTsconfigPathsResolver(configs);
  assert.deepEqual(targets('apps/web/main.ts', '@lib/x'), ['apps/web/source/lib/x', 'apps/web/source/@lib/x']);
});

test('specifiers named after Object.prototype members match no paths entry', () => {
  const patterns = { '@x/*': ['src/*'] };
  for (const specifier of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.deepEqual(matchPathPatterns(specifier, patterns), []);
  }
});

test('a __proto__ paths key stays an ordinary alias', () => {
  const parsed = parseTsconfigJsonc('{"compilerOptions":{"paths":{"__proto__":["proto.ts"],"@x/*":["src/*"]}}}');
  assert.ok(parsed?.paths);
  assert.equal(Object.getPrototypeOf(parsed.paths), Object.prototype);
  assert.deepEqual(Object.keys(parsed.paths), ['__proto__', '@x/*']);
  const targets = createTsconfigPathsResolver(new Map([['tsconfig.json', parsed]]));
  assert.deepEqual(targets('main.ts', '__proto__'), ['proto.ts']);
  assert.deepEqual(targets('main.ts', 'constructor'), []);
  assert.deepEqual(targets('main.ts', '@x/y'), ['src/y']);
});

test('JSONC parser stays linear on long comment and comma runs', () => {
  const source = `{${' '.repeat(20000)}/*${'x'.repeat(20000)}*/"compilerOptions":{"paths":{"a":["b",]}}}`;
  const startedAt = performance.now();
  assert.deepEqual(parseTsconfigJsonc(source)?.paths, { a: ['b'] });
  assert.ok(performance.now() - startedAt < 250);
});
