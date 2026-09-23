import path from 'node:path';
import { isRecord } from './change-map-core.ts';

export interface TsconfigPaths {
  extendsPath: string | null;
  baseUrl: string | null;
  paths: Record<string, string[]> | null;
}

interface DeclaredPaths {
  targets: string[];
  declaringDirectory: string;
}

interface EffectivePaths {
  baseUrl: string | null;
  declaredPathsByAlias: Map<string, DeclaredPaths>;
  patterns: Record<string, string[]>;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function cleanJsonc(sourceText: string): string | null {
  let cleaned = '';
  let isString = false;
  let isEscaped = false;
  for (let index = 0; index < sourceText.length; index++) {
    const character = sourceText[index];
    const next = sourceText[index + 1];
    if (isString) {
      cleaned += character;
      if (isEscaped) { isEscaped = false; continue; }
      if (character === '\\') { isEscaped = true; continue; }
      if (character === '"') isString = false;
      continue;
    }
    if (character === '"') { isString = true; cleaned += character; continue; }
    if (character === '/' && next === '/') {
      while (index < sourceText.length && sourceText[index] !== '\n') index++;
      cleaned += '\n';
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < sourceText.length && !(sourceText[index] === '*' && sourceText[index + 1] === '/')) {
        if (sourceText[index] === '\n') cleaned += '\n';
        index++;
      }
      if (index >= sourceText.length) return null;
      index++;
      continue;
    }
    cleaned += character;
  }
  if (isString) return null;
  let withoutTrailingCommas = '';
  isString = false;
  isEscaped = false;
  for (let index = 0; index < cleaned.length; index++) {
    const character = cleaned[index];
    if (isString) {
      withoutTrailingCommas += character;
      if (isEscaped) { isEscaped = false; continue; }
      if (character === '\\') { isEscaped = true; continue; }
      if (character === '"') isString = false;
      continue;
    }
    if (character === '"') { isString = true; withoutTrailingCommas += character; continue; }
    if (character === ',') {
      let nextIndex = index + 1;
      while (nextIndex < cleaned.length && /\s/.test(cleaned[nextIndex])) nextIndex++;
      if (cleaned[nextIndex] === '}' || cleaned[nextIndex] === ']') continue;
    }
    withoutTrailingCommas += character;
  }
  return withoutTrailingCommas;
}

export function parseTsconfigJsonc(sourceText: string): TsconfigPaths | null {
  try {
    const cleaned = cleanJsonc(sourceText);
    if (cleaned === null) return null;
    const config: unknown = JSON.parse(cleaned);
    if (!isRecord(config)) return null;
    const compilerOptions = isRecord(config.compilerOptions) ? config.compilerOptions : {};
    const paths = isRecord(compilerOptions.paths)
      ? Object.fromEntries(Object.entries(compilerOptions.paths).filter((entry): entry is [string, string[]] => isStringArray(entry[1])))
      : null;
    const extendsPath = typeof config.extends === 'string' && (config.extends.startsWith('./') || config.extends.startsWith('../')) ? config.extends : null;
    return { extendsPath, baseUrl: typeof compilerOptions.baseUrl === 'string' ? compilerOptions.baseUrl : null, paths };
  } catch {
    return null;
  }
}

export function matchPathPatterns(specifier: string, patterns: Record<string, string[]>): string[] {
  const exact = Object.hasOwn(patterns, specifier) ? patterns[specifier] : [];
  const matches: { prefixLength: number; alias: string; wildcard: string }[] = [];
  for (const alias of Object.keys(patterns)) {
    const star = alias.indexOf('*');
    if (star < 0 || alias.indexOf('*', star + 1) >= 0) continue;
    const prefix = alias.slice(0, star);
    const suffix = alias.slice(star + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    if (specifier.length < prefix.length + suffix.length) continue;
    matches.push({ prefixLength: prefix.length, alias, wildcard: specifier.slice(prefix.length, specifier.length - suffix.length) });
  }
  matches.sort((left, right) => right.prefixLength - left.prefixLength);
  return [...exact, ...matches.flatMap(({ alias, wildcard }) => patterns[alias].map((target) => target.replace('*', wildcard)))];
}

export function resolveExtendsPath(configPath: string, extendsPath: string): string {
  const extendsFile = extendsPath.endsWith('.json') ? extendsPath : `${extendsPath}.json`;
  return path.posix.normalize(path.posix.join(path.posix.dirname(configPath), extendsFile));
}

export function createTsconfigPathsResolver(configsByPath: Map<string, TsconfigPaths>): (fromPath: string, specifier: string) => string[] {
  const effectiveByConfig = new Map<string, EffectivePaths>();
  const configByDirectory = new Map<string, string | null>();
  const knownConfigs = new Set(configsByPath.keys());

  function effectiveFor(configPath: string, visiting: Set<string>): EffectivePaths {
    const cached = effectiveByConfig.get(configPath);
    if (cached) return cached;
    if (visiting.has(configPath)) return { baseUrl: null, declaredPathsByAlias: new Map(), patterns: {} };
    visiting.add(configPath);
    const config = configsByPath.get(configPath);
    const configDirectory = path.posix.dirname(configPath);
    const parentPath = config?.extendsPath ? resolveExtendsPath(configPath, config.extendsPath) : null;
    const parent = parentPath && knownConfigs.has(parentPath) ? effectiveFor(parentPath, visiting) : null;
    const ownBaseUrl = config?.baseUrl ?? null;
    const baseUrl = ownBaseUrl === null ? parent?.baseUrl ?? null : path.posix.normalize(path.posix.join(configDirectory, ownBaseUrl));
    const ownPaths = config?.paths ?? null;
    const declaredPathsByAlias = ownPaths === null
      ? new Map(parent?.declaredPathsByAlias)
      : new Map(Object.entries(ownPaths).map(([alias, targets]) => [alias, { targets, declaringDirectory: configDirectory }]));
    const patterns = Object.fromEntries([...declaredPathsByAlias].map(([alias, { targets, declaringDirectory }]) => [
      alias,
      targets.map((target) => path.posix.normalize(path.posix.join(baseUrl ?? declaringDirectory, target))),
    ]));
    const effective = { baseUrl, declaredPathsByAlias, patterns };
    visiting.delete(configPath);
    effectiveByConfig.set(configPath, effective);
    return effective;
  }

  function nearestConfig(directory: string): string | null {
    if (configByDirectory.has(directory)) return configByDirectory.get(directory) ?? null;
    const candidate = directory === '.' ? 'tsconfig.json' : `${directory}/tsconfig.json`;
    const found = knownConfigs.has(candidate) ? candidate : directory === '.' ? null : nearestConfig(path.posix.dirname(directory));
    configByDirectory.set(directory, found);
    return found;
  }

  return (fromPath, specifier) => {
    const configPath = nearestConfig(path.posix.dirname(fromPath));
    if (!configPath) return [];
    const effective = effectiveFor(configPath, new Set());
    const matches = matchPathPatterns(specifier, effective.patterns);
    if (effective.baseUrl === null) return matches;
    return [...matches, path.posix.join(effective.baseUrl, specifier)];
  };
}
