import type { Rect } from './whiteboard-layout-core.ts';

type IndexPair = [number, number];

interface FlatRects {
  count: number;
  lefts: Float64Array;
  tops: Float64Array;
  rights: Float64Array;
  bottoms: Float64Array;
}

interface YIntervalIndex {
  insert: (item: number) => void;
  remove: (item: number) => void;
  forEachMeeting: (top: number, bottom: number, onItem: (item: number) => void) => void;
}

function flatRectsOf(rects: readonly Rect[]): FlatRects {
  const flat = emptyFlatRects(rects.length);
  rects.forEach((rect, index) => {
    setFlatRect(flat, index, rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
  });
  return flat;
}

function emptyFlatRects(count: number): FlatRects {
  return { count, lefts: new Float64Array(count), tops: new Float64Array(count), rights: new Float64Array(count), bottoms: new Float64Array(count) };
}

function setFlatRect(flat: FlatRects, index: number, firstX: number, firstY: number, secondX: number, secondY: number): void {
  flat.lefts[index] = Math.min(firstX, secondX);
  flat.rights[index] = Math.max(firstX, secondX);
  flat.tops[index] = Math.min(firstY, secondY);
  flat.bottoms[index] = Math.max(firstY, secondY);
}

function distinctSorted(values: Float64Array): Float64Array {
  values.sort();
  let distinctCount = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? 0;
    if (distinctCount > 0 && values[distinctCount - 1] === value) continue;
    values[distinctCount] = value;
    distinctCount += 1;
  }
  return values.subarray(0, distinctCount);
}

function distinctSortedYs(groups: readonly FlatRects[]): Float64Array {
  const total = groups.reduce((sum, group) => sum + group.count * 2, 0);
  const ys = new Float64Array(total);
  let next = 0;
  for (const group of groups) {
    ys.set(group.tops, next);
    ys.set(group.bottoms, next + group.count);
    next += group.count * 2;
  }
  return distinctSorted(ys);
}

function leafOf(ys: Float64Array, value: number): number {
  let low = 0;
  let high = ys.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((ys[middle] ?? 0) < value) {
      low = middle + 1;
      continue;
    }
    high = middle;
  }
  return low;
}

function leafCapacityOf(leafCount: number): number {
  let capacity = 1;
  while (capacity < leafCount) capacity *= 2;
  return capacity;
}

function keepLiveItems(items: number[], isLive: Uint8Array, onItem: ((item: number) => void) | null): void {
  let kept = 0;
  for (const item of items) {
    if (isLive[item] !== 1) continue;
    items[kept] = item;
    kept += 1;
    if (onItem) onItem(item);
  }
  items.length = kept;
}

function createYIntervalIndex(rects: FlatRects, ys: Float64Array): YIntervalIndex {
  const capacity = leafCapacityOf(ys.length);
  const topLeafByItem = new Int32Array(rects.count);
  const bottomLeafByItem = new Int32Array(rects.count);
  for (let item = 0; item < rects.count; item += 1) {
    topLeafByItem[item] = leafOf(ys, rects.tops[item] ?? 0);
    bottomLeafByItem[item] = leafOf(ys, rects.bottoms[item] ?? 0);
  }
  const isLive = new Uint8Array(rects.count);
  const coveringItemsByNode: number[][] = Array.from({ length: capacity * 2 }, () => []);
  const startingItemsByLeaf: number[][] = Array.from({ length: capacity }, () => []);
  const liveStartCountByNode = new Int32Array(capacity * 2);

  const changeStartCount = (leaf: number, change: number) => {
    for (let node = leaf + capacity; node >= 1; node >>= 1) liveStartCountByNode[node] = (liveStartCountByNode[node] ?? 0) + change;
  };

  const insert = (item: number) => {
    isLive[item] = 1;
    const topLeaf = topLeafByItem[item] ?? 0;
    let left = topLeaf + capacity;
    let right = (bottomLeafByItem[item] ?? 0) + capacity + 1;
    while (left < right) {
      if (left & 1) {
        coveringItemsByNode[left]?.push(item);
        left += 1;
      }
      if (right & 1) {
        right -= 1;
        coveringItemsByNode[right]?.push(item);
      }
      left >>= 1;
      right >>= 1;
    }
    startingItemsByLeaf[topLeaf]?.push(item);
    changeStartCount(topLeaf, 1);
  };

  const remove = (item: number) => {
    if (isLive[item] !== 1) return;
    isLive[item] = 0;
    changeStartCount(topLeafByItem[item] ?? 0, -1);
  };

  const visitStartsBetween = (node: number, nodeFirstLeaf: number, nodeLastLeaf: number, firstLeaf: number, lastLeaf: number, onItem: (item: number) => void): void => {
    if ((liveStartCountByNode[node] ?? 0) === 0 || nodeLastLeaf < firstLeaf || nodeFirstLeaf > lastLeaf) return;
    if (node >= capacity) {
      keepLiveItems(startingItemsByLeaf[node - capacity] ?? [], isLive, onItem);
      return;
    }
    const middleLeaf = (nodeFirstLeaf + nodeLastLeaf) >> 1;
    visitStartsBetween(node * 2, nodeFirstLeaf, middleLeaf, firstLeaf, lastLeaf, onItem);
    visitStartsBetween(node * 2 + 1, middleLeaf + 1, nodeLastLeaf, firstLeaf, lastLeaf, onItem);
  };

  const forEachMeeting = (top: number, bottom: number, onItem: (item: number) => void) => {
    const topLeaf = leafOf(ys, top);
    for (let node = topLeaf + capacity; node >= 1; node >>= 1) keepLiveItems(coveringItemsByNode[node] ?? [], isLive, onItem);
    const lastLeaf = leafOf(ys, bottom);
    if (lastLeaf > topLeaf) visitStartsBetween(1, 0, capacity - 1, topLeaf + 1, lastLeaf, onItem);
  };

  return { insert, remove, forEachMeeting };
}

function orderBy(values: Float64Array): Int32Array {
  const order = new Int32Array(values.length);
  for (let index = 0; index < order.length; index += 1) order[index] = index;
  return order.sort((first, second) => (values[first] ?? 0) - (values[second] ?? 0));
}

interface SweepGroup {
  rects: FlatRects;
  index: YIntervalIndex;
  closingOrder: Int32Array;
  nextClosing: number;
}

function sweepGroupsOf(groups: readonly FlatRects[]): SweepGroup[] {
  const ys = distinctSortedYs(groups);
  return groups.map((rects) => ({ rects, index: createYIntervalIndex(rects, ys), closingOrder: orderBy(rects.rights), nextClosing: 0 }));
}

function closeBefore(group: SweepGroup, x: number): void {
  while (group.nextClosing < group.closingOrder.length) {
    const item = group.closingOrder[group.nextClosing] ?? 0;
    if ((group.rects.rights[item] ?? 0) >= x) return;
    group.index.remove(item);
    group.nextClosing += 1;
  }
}

function forEachTouchingPairWithin(rects: FlatRects, onPair: (earlier: number, later: number) => void): void {
  const [group] = sweepGroupsOf([rects]);
  if (!group) return;
  for (const item of orderBy(rects.lefts)) {
    closeBefore(group, rects.lefts[item] ?? 0);
    group.index.forEachMeeting(rects.tops[item] ?? 0, rects.bottoms[item] ?? 0, (open) => onPair(open, item));
    group.index.insert(item);
  }
}

function forEachTouchingPairAcross(firstRects: FlatRects, secondRects: FlatRects, onPair: (firstItem: number, secondItem: number) => void): void {
  const [first, second] = sweepGroupsOf([firstRects, secondRects]);
  if (!first || !second) return;
  const firstOpening = orderBy(firstRects.lefts);
  const secondOpening = orderBy(secondRects.lefts);
  let nextFirst = 0;
  let nextSecond = 0;
  while (nextFirst < firstOpening.length || nextSecond < secondOpening.length) {
    const firstItem = firstOpening[nextFirst] ?? -1;
    const secondItem = secondOpening[nextSecond] ?? -1;
    const opensFirst = secondItem < 0 || (firstItem >= 0 && (firstRects.lefts[firstItem] ?? 0) <= (secondRects.lefts[secondItem] ?? 0));
    const x = opensFirst ? firstRects.lefts[firstItem] ?? 0 : secondRects.lefts[secondItem] ?? 0;
    closeBefore(first, x);
    closeBefore(second, x);
    if (opensFirst) {
      second.index.forEachMeeting(firstRects.tops[firstItem] ?? 0, firstRects.bottoms[firstItem] ?? 0, (open) => onPair(firstItem, open));
      first.index.insert(firstItem);
      nextFirst += 1;
      continue;
    }
    first.index.forEachMeeting(secondRects.tops[secondItem] ?? 0, secondRects.bottoms[secondItem] ?? 0, (open) => onPair(open, secondItem));
    second.index.insert(secondItem);
    nextSecond += 1;
  }
}

function countingOrder(keys: Int32Array, keyCount: number, order: Int32Array): Int32Array {
  const startByKey = new Int32Array(keyCount + 1);
  for (const position of order) startByKey[(keys[position] ?? 0) + 1] = (startByKey[(keys[position] ?? 0) + 1] ?? 0) + 1;
  for (let key = 0; key < keyCount; key += 1) startByKey[key + 1] = (startByKey[key + 1] ?? 0) + (startByKey[key] ?? 0);
  const sorted = new Int32Array(order.length);
  for (const position of order) {
    const key = keys[position] ?? 0;
    sorted[startByKey[key] ?? 0] = position;
    startByKey[key] = (startByKey[key] ?? 0) + 1;
  }
  return sorted;
}

function orderOfPairs(firsts: readonly number[], seconds: readonly number[], firstCount: number, secondCount: number): Int32Array {
  const identity = new Int32Array(firsts.length);
  for (let position = 0; position < identity.length; position += 1) identity[position] = position;
  return countingOrder(Int32Array.from(firsts), firstCount, countingOrder(Int32Array.from(seconds), secondCount, identity));
}

function pairsInOrder(firsts: readonly number[], seconds: readonly number[], firstCount: number, secondCount: number): IndexPair[] {
  return Array.from(orderOfPairs(firsts, seconds, firstCount, secondCount), (position): IndexPair => [firsts[position] ?? 0, seconds[position] ?? 0]);
}

function touchingPairsWithin(rects: readonly Rect[]): IndexPair[] {
  const firsts: number[] = [];
  const seconds: number[] = [];
  forEachTouchingPairWithin(flatRectsOf(rects), (earlier, later) => {
    firsts.push(Math.min(earlier, later));
    seconds.push(Math.max(earlier, later));
  });
  return pairsInOrder(firsts, seconds, rects.length, rects.length);
}

export { distinctSorted, emptyFlatRects, flatRectsOf, forEachTouchingPairAcross, forEachTouchingPairWithin, leafCapacityOf, leafOf, orderOfPairs, setFlatRect, touchingPairsWithin };
export type { FlatRects };
