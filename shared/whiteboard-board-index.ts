import type { Board, Element } from './contracts/whiteboard.ts';

type ElementKind = Element['kind'];
type ElementOfKind<Kind extends ElementKind> = Extract<Element, { kind: Kind }>;

interface BoardIndex {
  elementCount: number;
  idsByKind: Map<ElementKind, Set<string>>;
  indexKeyIdsByKind: Map<ElementKind, Set<string>>;
  assetRefCount: Map<string, number>;
  dependentIdsByBoxId: Map<string, Set<string>>;
  stepBoxIds: Set<string>;
}

const indexByElements = new WeakMap<Board['elements'], BoardIndex>();
const ARRAY_INDEX_KEY = /^(?:0|[1-9]\d{0,9})$/;
const MAX_ARRAY_INDEX = 4294967294;

function isArrayIndexKey(id: string): boolean {
  return ARRAY_INDEX_KEY.test(id) && Number(id) <= MAX_ARRAY_INDEX;
}

function kindIdsOf(index: BoardIndex, id: string): Map<ElementKind, Set<string>> {
  return isArrayIndexKey(id) ? index.indexKeyIdsByKind : index.idsByKind;
}

function assetIdOf(element: Element | undefined): string | null {
  return element?.kind === 'box' && element.media ? element.media.asset : null;
}

function countAsset(index: BoardIndex, assetId: string | null, step: number): void {
  if (assetId === null) return;
  const count = (index.assetRefCount.get(assetId) ?? 0) + step;
  if (count > 0) {
    index.assetRefCount.set(assetId, count);
    return;
  }
  index.assetRefCount.delete(assetId);
}

function boxIdsDependedOnBy(element: Element): readonly string[] {
  if (element.kind === 'box') return element.near ? [element.near.of] : [];
  if (element.kind === 'wire') return [element.from, element.to];
  if (element.kind === 'note') return [element.on];
  if (element.kind === 'frame') return element.contains;
  return [];
}

function trackStep(index: BoardIndex, element: Element, isPresent: boolean): void {
  if (element.kind !== 'box' || element.step === null) return;
  if (isPresent) {
    index.stepBoxIds.add(element.id);
    return;
  }
  index.stepBoxIds.delete(element.id);
}

function linkDependent(index: BoardIndex, element: Element): void {
  for (const boxId of boxIdsDependedOnBy(element)) {
    const dependentIds = index.dependentIdsByBoxId.get(boxId) ?? new Set<string>();
    dependentIds.add(element.id);
    index.dependentIdsByBoxId.set(boxId, dependentIds);
  }
}

function unlinkDependent(index: BoardIndex, element: Element): void {
  for (const boxId of boxIdsDependedOnBy(element)) {
    const dependentIds = index.dependentIdsByBoxId.get(boxId);
    dependentIds?.delete(element.id);
    if (dependentIds?.size === 0) index.dependentIdsByBoxId.delete(boxId);
  }
}

function addToIndex(index: BoardIndex, element: Element): void {
  const idsByKind = kindIdsOf(index, element.id);
  const sameKindIds = idsByKind.get(element.kind) ?? new Set<string>();
  sameKindIds.add(element.id);
  idsByKind.set(element.kind, sameKindIds);
  index.elementCount += 1;
  countAsset(index, assetIdOf(element), 1);
  linkDependent(index, element);
  trackStep(index, element, true);
}

function removeFromIndex(index: BoardIndex, element: Element): void {
  kindIdsOf(index, element.id).get(element.kind)?.delete(element.id);
  index.elementCount -= 1;
  countAsset(index, assetIdOf(element), -1);
  unlinkDependent(index, element);
  trackStep(index, element, false);
}

function boardIndexOf(elements: Board['elements']): BoardIndex {
  const known = indexByElements.get(elements);
  if (known) return known;
  const index: BoardIndex = { elementCount: 0, idsByKind: new Map(), indexKeyIdsByKind: new Map(), assetRefCount: new Map(), dependentIdsByBoxId: new Map(), stepBoxIds: new Set() };
  for (const element of Object.values(elements)) addToIndex(index, element);
  indexByElements.set(elements, index);
  return index;
}

function isOfKind<Kind extends ElementKind>(element: Element | undefined, kind: Kind): element is ElementOfKind<Kind> {
  return element?.kind === kind;
}

function sortedIndexKeyIds(index: BoardIndex, kind: ElementKind): string[] {
  return [...index.indexKeyIdsByKind.get(kind) ?? []].sort((left, right) => Number(left) - Number(right));
}

function elementsOfKind<Kind extends ElementKind>(board: Board, kind: Kind): ElementOfKind<Kind>[] {
  const index = boardIndexOf(board.elements);
  const found: ElementOfKind<Kind>[] = [];
  const collect = (id: string): void => {
    const element = board.elements[id];
    if (isOfKind(element, kind)) found.push(element);
  };
  for (const id of sortedIndexKeyIds(index, kind)) collect(id);
  for (const id of index.idsByKind.get(kind) ?? []) collect(id);
  return found;
}

function storeElement(elements: Board['elements'], element: Element): void {
  const index = indexByElements.get(elements);
  const previous = elements[element.id];
  elements[element.id] = element;
  if (!index) return;
  if (!previous) {
    addToIndex(index, element);
    return;
  }
  countAsset(index, assetIdOf(previous), -1);
  countAsset(index, assetIdOf(element), 1);
  unlinkDependent(index, previous);
  linkDependent(index, element);
  trackStep(index, previous, false);
  trackStep(index, element, true);
}

function appendElement(elements: Board['elements'], element: Element): void {
  dropElement(elements, element.id);
  storeElement(elements, element);
}

function dropElement(elements: Board['elements'], id: string): void {
  const previous = elements[id];
  if (!previous) return;
  delete elements[id];
  const index = indexByElements.get(elements);
  if (index) removeFromIndex(index, previous);
}

function assetIdsOf(board: Board): Set<string> {
  return new Set(boardIndexOf(board.elements).assetRefCount.keys());
}

export { appendElement, assetIdOf, assetIdsOf, boardIndexOf, boxIdsDependedOnBy, dropElement, elementsOfKind, storeElement };
