import type { Camera } from '../whiteboard/board-gl-renderer.ts';
import type { Rect } from '#shared/whiteboard-layout-core.ts';

export interface RepoSession {
  id: string;
  path: string;
}

export interface RepoChoice {
  path: string;
  label: string;
  sessionIds: string[];
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
const MAX_FIT_SCALE = 2;
const FIT_MARGIN_PX = 48;
const READABLE_TITLE_PX = 9;

function repoLabelOf(repoPath: string): string {
  const trimmedPath = repoPath.replace(/[\\/]+$/, '');
  return trimmedPath.slice(Math.max(trimmedPath.lastIndexOf('/'), trimmedPath.lastIndexOf('\\')) + 1) || trimmedPath;
}

export function repoChoicesOf(sessions: readonly RepoSession[]): RepoChoice[] {
  const sessionIdsByPath = new Map<string, string[]>();
  for (const session of sessions) sessionIdsByPath.set(session.path, [...(sessionIdsByPath.get(session.path) ?? []), session.id]);
  return [...sessionIdsByPath].map(([path, sessionIds]) => ({ path, label: repoLabelOf(path), sessionIds })).sort((left, right) => left.label.localeCompare(right.label) || left.path.localeCompare(right.path));
}

export function pickedRepoPath(shownPath: string | null, rememberedPath: string | null, knownPaths: readonly string[]): string | null {
  if (shownPath !== null && knownPaths.includes(shownPath)) return shownPath;
  if (rememberedPath !== null && knownPaths.includes(rememberedPath)) return rememberedPath;
  return knownPaths[0] ?? null;
}

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function readableFloorScale(titleSizePx: number): number {
  return clampScale(READABLE_TITLE_PX / titleSizePx);
}

function fittedCamera(bounds: Rect, viewWidthPx: number, viewHeightPx: number, reservedBottomPx: number, floorScale = MIN_SCALE): Camera | null {
  const usableHeightPx = viewHeightPx - reservedBottomPx - FIT_MARGIN_PX * 2;
  const usableWidthPx = viewWidthPx - FIT_MARGIN_PX * 2;
  if (usableWidthPx <= 0 || usableHeightPx <= 0 || bounds.width <= 0 || bounds.height <= 0) return null;
  const fitScale = clampScale(Math.min(MAX_FIT_SCALE, usableWidthPx / bounds.width, usableHeightPx / bounds.height));
  if (fitScale < floorScale) return { x: bounds.x - FIT_MARGIN_PX / floorScale, y: bounds.y - FIT_MARGIN_PX / floorScale, scale: floorScale };
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return { x: centerX - viewWidthPx / 2 / fitScale, y: centerY - (FIT_MARGIN_PX + usableHeightPx / 2) / fitScale, scale: fitScale };
}

export function isBelowFloor(bounds: Rect, viewWidthPx: number, viewHeightPx: number, reservedBottomPx: number, floorScale: number): boolean {
  const fitted = fittedCamera(bounds, viewWidthPx, viewHeightPx, reservedBottomPx);
  return fitted !== null && fitted.scale < floorScale;
}

function shiftToFit(start: number, length: number, clearStart: number, clearLength: number): number {
  if (length > clearLength || start < clearStart) return start - clearStart;
  return Math.max(0, start + length - (clearStart + clearLength));
}

export function viewMovedToShow(area: Rect, clearArea: Rect, view: Rect): Rect | null {
  const shiftX = shiftToFit(area.x, area.width, clearArea.x, clearArea.width);
  const shiftY = shiftToFit(area.y, area.height, clearArea.y, clearArea.height);
  if (shiftX === 0 && shiftY === 0) return null;
  return { ...view, x: view.x + shiftX, y: view.y + shiftY };
}
