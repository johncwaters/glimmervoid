import crypto from 'node:crypto';

import { CODEMAP_TUNABLES } from './codemap-graph-core.ts';
import type { ScipDocument } from './scip-index-core.ts';
import { SCIP_SYMBOL_ROLES } from './scip-index-core.ts';

export interface UnjudgedLanguage {
  language: string;
  reason: string;
}

export interface SymbolGraph {
  treeSha: string;
  symbols: readonly string[];
  fileOfSymbol: Int32Array;
  files: readonly string[];
  edgesFrom: Int32Array;
  edgesTo: Int32Array;
  unjudgedLanguages: readonly UnjudgedLanguage[];
}

export interface Tangle {
  key: string;
  symbols: string[];
  modules: string[];
}

export interface ShallowModule {
  module: string;
  shown: string[];
  hiddenCount: number;
}

const SYMBOL_HEADER_COMPONENTS = 4;
const POSITION_LINE_FACTOR = 2 ** 24;
const EDGE_KEY_FACTOR = 2 ** 26;
const TANGLE_KEY_HEX_LENGTH = 12;
const UNDEFINED_FILE = -1;
const SIMPLE_NAME_CHARACTER = /[\w+\-$]/;

interface Owner {
  start: number;
  end: number;
  ownerId: number;
}

interface Reference {
  position: number;
  usedId: number;
}

function headerSeparatorsOf(symbol: string): number[] | null {
  const separators: number[] = [];
  let offset = 0;
  while (separators.length < SYMBOL_HEADER_COMPONENTS) {
    const space = symbol.indexOf(' ', offset);
    if (space < 0) return null;
    if (symbol[space + 1] === ' ') {
      offset = space + 2;
      continue;
    }
    separators.push(space);
    offset = space + 1;
  }
  return separators;
}

function nameEndOf(symbol: string, start: number): number {
  if (symbol[start] === '`') {
    let offset = start + 1;
    while (offset < symbol.length) {
      if (symbol[offset] !== '`') {
        offset++;
        continue;
      }
      if (symbol[offset + 1] === '`') {
        offset += 2;
        continue;
      }
      return offset + 1;
    }
    return -1;
  }
  let offset = start;
  while (offset < symbol.length && SIMPLE_NAME_CHARACTER.test(symbol[offset])) offset++;
  return offset === start ? -1 : offset;
}

function topLevelDescriptorsEndOf(symbol: string, descriptorsStart: number): number {
  let offset = descriptorsStart;
  while (offset < symbol.length) {
    const nameEnd = nameEndOf(symbol, offset);
    if (nameEnd < 0) return -1;
    const suffix = symbol[nameEnd];
    if (suffix === '/') {
      offset = nameEnd + 1;
      continue;
    }
    if (suffix === '#' || suffix === '.' || suffix === '!') return nameEnd + 1;
    if (suffix !== '(') return -1;
    const methodEnd = symbol.indexOf(').', nameEnd);
    return methodEnd < 0 ? -1 : methodEnd + 2;
  }
  return -1;
}

function topLevelSymbolOf(symbol: string): string | null {
  if (symbol.startsWith('local ')) return null;
  const separators = headerSeparatorsOf(symbol);
  if (separators === null) return null;
  const [, managerEnd, packageNameEnd, versionEnd] = separators;
  const descriptorsEnd = topLevelDescriptorsEndOf(symbol, versionEnd + 1);
  if (descriptorsEnd < 0) return null;
  return `${symbol.slice(managerEnd + 1, packageNameEnd)} ${symbol.slice(versionEnd + 1, descriptorsEnd)}`;
}

function positionOf(line: number, character: number): number {
  return line * POSITION_LINE_FACTOR + character;
}

function compareOwners(left: Owner, right: Owner): number {
  return left.start - right.start || right.end - left.end;
}

function addOwnedEdges(owners: Owner[], references: Reference[], edgeKeys: Set<number>): void {
  owners.sort(compareOwners);
  references.sort((left, right) => left.position - right.position);
  const openOwners: Owner[] = [];
  let nextOwnerIndex = 0;
  for (const reference of references) {
    while (nextOwnerIndex < owners.length && owners[nextOwnerIndex].start <= reference.position) {
      const opening = owners[nextOwnerIndex++];
      while (openOwners.length > 0 && openOwners[openOwners.length - 1].end <= opening.start) openOwners.pop();
      openOwners.push(opening);
    }
    while (openOwners.length > 0 && openOwners[openOwners.length - 1].end <= reference.position) openOwners.pop();
    const innermost = openOwners[openOwners.length - 1];
    if (innermost === undefined || innermost.ownerId === reference.usedId) continue;
    edgeKeys.add(innermost.ownerId * EDGE_KEY_FACTOR + reference.usedId);
  }
}

export function symbolGraphOfIndex(treeSha: string, documents: Iterable<ScipDocument>, isTestPath: (repoPath: string) => boolean): SymbolGraph {
  const idBySymbol = new Map<string, number>();
  const internedSymbols: string[] = [];
  const definingFileById: number[] = [];
  const files: string[] = [];
  const edgeKeys = new Set<number>();
  const internedIdOf = (symbol: string): number => {
    const known = idBySymbol.get(symbol);
    if (known !== undefined) return known;
    const id = internedSymbols.push(symbol) - 1;
    if (id >= EDGE_KEY_FACTOR) throw new Error('SCIP index holds more symbols than the symbol graph can key');
    idBySymbol.set(symbol, id);
    definingFileById.push(UNDEFINED_FILE);
    return id;
  };
  for (const document of documents) {
    if (isTestPath(document.relativePath)) continue;
    const fileIndex = files.push(document.relativePath) - 1;
    const owners: Owner[] = [];
    const references: Reference[] = [];
    for (const occurrence of document.occurrences) {
      if ((occurrence.roles & SCIP_SYMBOL_ROLES.test) !== 0) continue;
      const topLevelSymbol = topLevelSymbolOf(occurrence.symbol);
      if (topLevelSymbol === null) continue;
      const symbolId = internedIdOf(topLevelSymbol);
      if ((occurrence.roles & SCIP_SYMBOL_ROLES.definition) === 0) {
        if ((occurrence.roles & SCIP_SYMBOL_ROLES.import) === 0) references.push({ position: positionOf(occurrence.startLine, occurrence.startCharacter), usedId: symbolId });
        continue;
      }
      if (definingFileById[symbolId] === UNDEFINED_FILE) definingFileById[symbolId] = fileIndex;
      const enclosing = occurrence.enclosingRange;
      if (enclosing !== null) owners.push({ start: positionOf(enclosing.startLine, enclosing.startCharacter), end: positionOf(enclosing.endLine, enclosing.endCharacter), ownerId: symbolId });
    }
    addOwnedEdges(owners, references, edgeKeys);
  }
  return denseGraphOf(treeSha, internedSymbols, definingFileById, files, edgeKeys);
}

function denseGraphOf(treeSha: string, internedSymbols: readonly string[], definingFileById: readonly number[], files: readonly string[], edgeKeys: ReadonlySet<number>): SymbolGraph {
  const denseIdByInternedId = new Int32Array(internedSymbols.length).fill(-1);
  const definedIds = internedSymbols.map((_, internedId) => internedId).filter((internedId) => definingFileById[internedId] !== UNDEFINED_FILE);
  definedIds.sort((left, right) => (internedSymbols[left] < internedSymbols[right] ? -1 : 1));
  definedIds.forEach((internedId, denseId) => {
    denseIdByInternedId[internedId] = denseId;
  });
  const definedEdges: [number, number][] = [];
  for (const edgeKey of edgeKeys) {
    const from = denseIdByInternedId[Math.floor(edgeKey / EDGE_KEY_FACTOR)];
    const to = denseIdByInternedId[edgeKey % EDGE_KEY_FACTOR];
    if (from >= 0 && to >= 0) definedEdges.push([from, to]);
  }
  definedEdges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  return {
    treeSha,
    symbols: definedIds.map((internedId) => internedSymbols[internedId]),
    fileOfSymbol: Int32Array.from(definedIds, (internedId) => definingFileById[internedId]),
    files,
    edgesFrom: Int32Array.from(definedEdges, (edge) => edge[0]),
    edgesTo: Int32Array.from(definedEdges, (edge) => edge[1]),
    unjudgedLanguages: [],
  };
}

function edgeOffsetsOf(graph: SymbolGraph): Int32Array {
  const offsets = new Int32Array(graph.symbols.length + 1);
  for (const from of graph.edgesFrom) offsets[from + 1]++;
  for (let symbolId = 0; symbolId < graph.symbols.length; symbolId++) offsets[symbolId + 1] += offsets[symbolId];
  return offsets;
}

function moduleOfSymbolOf(graph: SymbolGraph, moduleOfPath: (repoPath: string) => string): (symbolId: number) => string {
  const moduleByFile = graph.files.map(moduleOfPath);
  return (symbolId) => moduleByFile[graph.fileOfSymbol[symbolId]];
}

function stronglyConnectedSetsOf(graph: SymbolGraph): number[][] {
  const symbolCount = graph.symbols.length;
  const offsets = edgeOffsetsOf(graph);
  const visitOrder = new Int32Array(symbolCount).fill(-1);
  const lowestReachable = new Int32Array(symbolCount);
  const isOnStack = new Uint8Array(symbolCount);
  const edgeCursor = new Int32Array(symbolCount);
  const componentStack: number[] = [];
  const walkStack: number[] = [];
  const components: number[][] = [];
  let nextVisitOrder = 0;
  const visit = (symbolId: number): void => {
    visitOrder[symbolId] = nextVisitOrder;
    lowestReachable[symbolId] = nextVisitOrder;
    nextVisitOrder++;
    componentStack.push(symbolId);
    isOnStack[symbolId] = 1;
    edgeCursor[symbolId] = offsets[symbolId];
    walkStack.push(symbolId);
  };
  for (let root = 0; root < symbolCount; root++) {
    if (visitOrder[root] !== -1) continue;
    visit(root);
    while (walkStack.length > 0) {
      const current = walkStack[walkStack.length - 1];
      if (edgeCursor[current] < offsets[current + 1]) {
        const target = graph.edgesTo[edgeCursor[current]++];
        if (visitOrder[target] === -1) {
          visit(target);
          continue;
        }
        if (isOnStack[target] === 1) lowestReachable[current] = Math.min(lowestReachable[current], visitOrder[target]);
        continue;
      }
      walkStack.pop();
      const parent = walkStack[walkStack.length - 1];
      if (parent !== undefined) lowestReachable[parent] = Math.min(lowestReachable[parent], lowestReachable[current]);
      if (lowestReachable[current] !== visitOrder[current]) continue;
      const component: number[] = [];
      for (;;) {
        const member = componentStack.pop();
        if (member === undefined) break;
        isOnStack[member] = 0;
        component.push(member);
        if (member === current) break;
      }
      if (component.length > 1) components.push(component);
    }
  }
  return components;
}

function tangleKeyOf(symbols: readonly string[]): string {
  return crypto.createHash('sha256').update(symbols.join('\n')).digest('hex').slice(0, TANGLE_KEY_HEX_LENGTH);
}

export function tanglesOf(graph: SymbolGraph, moduleOfPath: (repoPath: string) => string): Tangle[] {
  const moduleOfSymbol = moduleOfSymbolOf(graph, moduleOfPath);
  return stronglyConnectedSetsOf(graph)
    .flatMap((component) => {
      const modules = [...new Set(component.map(moduleOfSymbol))].sort();
      if (modules.length < 2 && component.length <= CODEMAP_TUNABLES.maxTangleSymbols) return [];
      const symbols = component.map((symbolId) => graph.symbols[symbolId]).sort();
      return [{ key: tangleKeyOf(symbols), symbols, modules }];
    })
    .sort((left, right) => right.symbols.length - left.symbols.length || (left.key < right.key ? -1 : 1));
}

export function shallowModulesOf(graph: SymbolGraph, moduleOfPath: (repoPath: string) => string): ShallowModule[] {
  const moduleOfSymbol = moduleOfSymbolOf(graph, moduleOfPath);
  const isShown = new Uint8Array(graph.symbols.length);
  for (let edgeIndex = 0; edgeIndex < graph.edgesFrom.length; edgeIndex++) {
    const to = graph.edgesTo[edgeIndex];
    if (moduleOfSymbol(graph.edgesFrom[edgeIndex]) !== moduleOfSymbol(to)) isShown[to] = 1;
  }
  const shownByModule = new Map<string, string[]>();
  const definedCountByModule = new Map<string, number>();
  for (let symbolId = 0; symbolId < graph.symbols.length; symbolId++) {
    const moduleId = moduleOfSymbol(symbolId);
    definedCountByModule.set(moduleId, (definedCountByModule.get(moduleId) ?? 0) + 1);
    if (isShown[symbolId] === 0) continue;
    const shown = shownByModule.get(moduleId) ?? [];
    shown.push(graph.symbols[symbolId]);
    shownByModule.set(moduleId, shown);
  }
  return [...shownByModule]
    .flatMap(([moduleId, shown]) => {
      const hiddenCount = (definedCountByModule.get(moduleId) ?? 0) - shown.length;
      if (shown.length <= CODEMAP_TUNABLES.maxShownSymbols || shown.length < hiddenCount) return [];
      return [{ module: moduleId, shown: shown.sort(), hiddenCount }];
    })
    .sort((left, right) => (left.module < right.module ? -1 : 1));
}

export function newTanglesOf(head: readonly Tangle[], mainline: readonly Tangle[], allowed: readonly string[]): Tangle[] {
  const mainlineTangleIndexBySymbol = new Map<string, number>();
  mainline.forEach((tangle, tangleIndex) => {
    for (const symbol of tangle.symbols) mainlineTangleIndexBySymbol.set(symbol, tangleIndex);
  });
  const isInsideOneMainlineTangle = (tangle: Tangle): boolean => {
    const mainlineIndexes = new Set(tangle.symbols.map((symbol) => mainlineTangleIndexBySymbol.get(symbol)));
    return mainlineIndexes.size === 1 && !mainlineIndexes.has(undefined);
  };
  const allowedKeys = new Set(allowed);
  return head.filter((tangle) => !allowedKeys.has(tangle.key) && !isInsideOneMainlineTangle(tangle));
}

export function newShallowModulesOf(head: readonly ShallowModule[], mainline: readonly ShallowModule[], allowed: readonly string[]): ShallowModule[] {
  const mainlineShownCountByModule = new Map(mainline.map((shallow) => [shallow.module, shallow.shown.length]));
  const allowedModules = new Set(allowed);
  return head.filter((shallow) => !allowedModules.has(shallow.module) && shallow.shown.length > (mainlineShownCountByModule.get(shallow.module) ?? 0));
}
