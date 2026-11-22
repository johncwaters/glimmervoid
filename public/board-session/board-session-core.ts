import type { Camera } from '../whiteboard/board-gl-renderer.ts';
import type { Rect } from '#shared/whiteboard-layout-core.ts';

export interface SessionChoice {
  id: string;
  name: string;
  path: string;
}

const WORKTREE_SUFFIX = /-[A-Za-z0-9]{6}$/;
const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
const MAX_FIT_SCALE = 2;
const FIT_MARGIN_PX = 48;
const READABLE_TITLE_PX = 9;

function repoStemOf(path: string): string {
  const trimmedPath = path.replace(/\/+$/, '');
  const baseName = trimmedPath.slice(trimmedPath.lastIndexOf('/') + 1);
  return baseName.replace(WORKTREE_SUFFIX, '');
}

export function orderedSessionChoices(choices: readonly SessionChoice[], shownPath: string | null): SessionChoice[] {
  const shownStem = shownPath === null ? null : repoStemOf(shownPath);
  const isSameRepo = (choice: SessionChoice) => shownStem !== null && repoStemOf(choice.path) === shownStem;
  return [...choices].sort((left, right) => Number(isSameRepo(right)) - Number(isSameRepo(left)) || left.name.localeCompare(right.name));
}

export function pickedSessionId(shownSessionId: string | null, selectedSessionId: string | null, knownSessionIds: readonly string[]): string | null {
  if (shownSessionId !== null && knownSessionIds.includes(shownSessionId)) return shownSessionId;
  if (selectedSessionId !== null && knownSessionIds.includes(selectedSessionId)) return selectedSessionId;
  return knownSessionIds[0] ?? null;
}

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function zoomedCamera(camera: Camera, pointX: number, pointY: number, zoomFactor: number): Camera {
  const scale = clampScale(camera.scale * zoomFactor);
  const worldX = camera.x + pointX / camera.scale;
  const worldY = camera.y + pointY / camera.scale;
  return { x: worldX - pointX / scale, y: worldY - pointY / scale, scale };
}

export function readableFloorScale(titleSizePx: number): number {
  return clampScale(READABLE_TITLE_PX / titleSizePx);
}

export function fittedCamera(bounds: Rect, viewWidthPx: number, viewHeightPx: number, reservedBottomPx: number, floorScale = MIN_SCALE): Camera | null {
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
