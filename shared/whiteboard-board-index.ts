import { linesOfBox, mediaOfBox } from './contracts/whiteboard.ts';
import type { Board, Element } from './contracts/whiteboard.ts';

type ElementKind = Element['kind'];
type ElementOfKind<Kind extends ElementKind> = Extract<Element, { kind: Kind }>;

interface BoardIndex {
  elementCount: number;
  strokeCount: number;
  assetRefCount: Map<string, number>;
  dependentIdsByBoxId: Map<string, readonly string[] | Set<string>>;
  stepBoxIds: Set<string>;
  anchoredIds: Set<string>;
}

const MAX_DEPENDENT_ARRAY_LENGTH = 16;
const indexByElements = new WeakMap<Board['elements'], BoardIndex>();

function assetIdOf(element: Element | undefined): string | null {
  return element?.kind === 'box' ? mediaOfBox(element)?.asset ?? null : null;
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

function hasAnchorRef(element: Element): boolean {
  if (element.kind === 'note') return element.ref !== null;
  return element.kind === 'box' && (element.refs.length > 0 || linesOfBox(element).some((line) => line.ref !== null));
}

function trackAnchor(index: BoardIndex, element: Element): void {
  if (hasAnchorRef(element)) {
    index.anchoredIds.add(element.id);
    return;
  }
  index.anchoredIds.delete(element.id);
}

function linkDependent(index: BoardIndex, element: Element, elements: Board['elements']): void {
  for (const boxId of new Set(boxIdsDependedOnBy(element))) {
    const dependentIds = index.dependentIdsByBoxId.get(boxId);
    if (!dependentIds) {
      index.dependentIdsByBoxId.set(elements.storedIdOf(boxId) ?? boxId, [element.id]);
      continue;
    }
    if (dependentIds instanceof Set) {
      dependentIds.add(element.id);
      continue;
    }
    if (dependentIds.length < MAX_DEPENDENT_ARRAY_LENGTH) {
      index.dependentIdsByBoxId.set(boxId, dependentIds.concat(element.id));
      continue;
    }
    index.dependentIdsByBoxId.set(boxId, new Set([...dependentIds, element.id]));
  }
}

function unlinkDependent(index: BoardIndex, element: Element): void {
  for (const boxId of new Set(boxIdsDependedOnBy(element))) {
    const dependentIds = index.dependentIdsByBoxId.get(boxId);
    if (dependentIds instanceof Set) {
      dependentIds.delete(element.id);
      if (dependentIds.size === 0) index.dependentIdsByBoxId.delete(boxId);
      continue;
    }
    if (!dependentIds?.includes(element.id)) continue;
    if (dependentIds.length === 1) {
      index.dependentIdsByBoxId.delete(boxId);
      continue;
    }
    index.dependentIdsByBoxId.set(boxId, dependentIds.filter((dependentId) => dependentId !== element.id));
  }
}

function withStoredId(elements: Board['elements'], element: Element): Element {
  return { ...element, id: elements.storedIdOf(element.id) ?? element.id };
}

function addToIndex(index: BoardIndex, element: Element, elements: Board['elements']): void {
  index.elementCount += 1;
  if (element.kind === 'stroke') index.strokeCount += 1;
  countAsset(index, assetIdOf(element), 1);
  linkDependent(index, element, elements);
  trackStep(index, element, true);
  trackAnchor(index, element);
}

function removeFromIndex(index: BoardIndex, element: Element): void {
  index.elementCount -= 1;
  if (element.kind === 'stroke') index.strokeCount -= 1;
  countAsset(index, assetIdOf(element), -1);
  unlinkDependent(index, element);
  trackStep(index, element, false);
  index.anchoredIds.delete(element.id);
}

function boardIndexOf(elements: Board['elements']): BoardIndex {
  const known = indexByElements.get(elements);
  if (known) return known;
  const index: BoardIndex = { elementCount: 0, strokeCount: 0, assetRefCount: new Map(), dependentIdsByBoxId: new Map(), stepBoxIds: new Set(), anchoredIds: new Set() };
  for (const element of elements.values()) addToIndex(index, element, elements);
  indexByElements.set(elements, index);
  return index;
}

function copyOfIndex(index: BoardIndex): BoardIndex {
  return {
    elementCount: index.elementCount,
    strokeCount: index.strokeCount,
    assetRefCount: new Map(index.assetRefCount),
    dependentIdsByBoxId: new Map([...index.dependentIdsByBoxId].map(([boxId, dependentIds]) => [boxId, dependentIds instanceof Set ? new Set(dependentIds) : dependentIds])),
    stepBoxIds: new Set(index.stepBoxIds),
    anchoredIds: new Set(index.anchoredIds),
  };
}

function copyOfElements(elements: Board['elements']): Board['elements'] {
  const copied = elements.copy();
  const known = indexByElements.get(elements);
  if (known) indexByElements.set(copied, copyOfIndex(known));
  return copied;
}

function elementsOfKind<Kind extends ElementKind>(board: Board, kind: Kind): ElementOfKind<Kind>[] {
  return [...board.elements.valuesOfKind(kind)];
}

function storeElement(elements: Board['elements'], element: Element): void {
  const index = indexByElements.get(elements);
  const previous = elements.get(element.id);
  elements.put(element);
  if (!index) return;
  const stored = withStoredId(elements, element);
  if (!previous) {
    addToIndex(index, stored, elements);
    return;
  }
  countAsset(index, assetIdOf(previous), -1);
  countAsset(index, assetIdOf(element), 1);
  unlinkDependent(index, previous);
  linkDependent(index, stored, elements);
  trackStep(index, previous, false);
  trackStep(index, stored, true);
  trackAnchor(index, stored);
}

function appendElement(elements: Board['elements'], element: Element): void {
  dropElement(elements, element.id);
  storeElement(elements, element);
}

function dropElement(elements: Board['elements'], id: string): void {
  const previous = elements.get(id);
  if (!previous) return;
  elements.remove(id);
  const index = indexByElements.get(elements);
  if (index) removeFromIndex(index, previous);
}

function assetIdsOf(board: Board): Set<string> {
  return new Set(boardIndexOf(board.elements).assetRefCount.keys());
}

export { appendElement, assetIdOf, assetIdsOf, boardIndexOf, boxIdsDependedOnBy, copyOfElements, dropElement, elementsOfKind, storeElement };
