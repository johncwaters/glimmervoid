import { FIT_ZOOM, isZoomedIn, panBy, stagePointOf, toggleFitAbout, wheelZoomFactor, zoomAbout } from './media-zoom-core.ts';
import type { MediaZoom, StagePoint } from './media-zoom-core.ts';
import { WHEEL_ZOOM_STEP } from './board-edit.ts';
import type { BoardPageGesture } from '#shared/contracts/whiteboard.ts';

const PAN_SLOP_PX = 6;
const DOUBLE_TAP_WINDOW_MS = 300;
const DOUBLE_TAP_REACH_PX = 30;

type StageGesture =
  | { kind: 'idle' }
  | { kind: 'pressed'; pointerId: number; start: StagePoint }
  | { kind: 'panning'; pointerId: number; last: StagePoint }
  | { kind: 'pinching'; distance: number; midpoint: StagePoint };

export type MediaZoomControl = {
  zoomAt: (mediaPoint: StagePoint, factor: number) => void;
  panBy: (deltaX: number, deltaY: number) => void;
  toggleFitAt: (mediaPoint: StagePoint) => void;
  isZoomed: () => boolean;
};

export function applyPageGesture(control: MediaZoomControl, gesture: BoardPageGesture): void {
  switch (gesture.gesture) {
    case 'pinch':
      control.zoomAt({ x: gesture.centerX, y: gesture.centerY }, gesture.scaleFactor);
      return;
    case 'pan':
      control.panBy(gesture.deltaX, gesture.deltaY);
      return;
    case 'wheel':
      if (gesture.isZoom) {
        control.zoomAt({ x: gesture.centerX, y: gesture.centerY }, wheelZoomFactor(gesture.deltaY, WHEEL_ZOOM_STEP));
        return;
      }
      control.panBy(-gesture.deltaX, -gesture.deltaY);
      return;
    case 'doubleTap':
      control.toggleFitAt({ x: gesture.centerX, y: gesture.centerY });
  }
}

export function attachMediaZoom(stage: HTMLElement, media: HTMLElement, onZoomedChange: (isZoomed: boolean) => void): MediaZoomControl {
  let zoom: MediaZoom = FIT_ZOOM;
  let gesture: StageGesture = { kind: 'idle' };
  let lastTap: { at: number; point: StagePoint } | null = null;
  let lastPointerType = '';
  const pointers = new Map<number, StagePoint>();
  media.classList.add('wb-zoomable-media');

  function stageSize() {
    return { width: stage.clientWidth, height: stage.clientHeight };
  }

  function stagePointOfClient(clientX: number, clientY: number): StagePoint {
    const stageRect = stage.getBoundingClientRect();
    return { x: clientX - stageRect.left, y: clientY - stageRect.top };
  }

  function show(nextZoom: MediaZoom): void {
    const wasZoomed = isZoomedIn(zoom);
    zoom = nextZoom;
    media.style.transform = `translate(${zoom.offsetX}px, ${zoom.offsetY}px) scale(${zoom.scale})`;
    if (wasZoomed !== isZoomedIn(zoom)) onZoomedChange(isZoomedIn(zoom));
  }

  function pinchShape(): { distance: number; midpoint: StagePoint } {
    const [first, second] = [...pointers.values()];
    if (!first || !second) return { distance: 0, midpoint: { x: 0, y: 0 } };
    return { distance: Math.hypot(first.x - second.x, first.y - second.y), midpoint: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 } };
  }

  function isDoubleTap(point: StagePoint): boolean {
    const now = performance.now();
    const previousTap = lastTap;
    lastTap = { at: now, point };
    if (!previousTap || now - previousTap.at > DOUBLE_TAP_WINDOW_MS) return false;
    lastTap = null;
    return Math.hypot(point.x - previousTap.point.x, point.y - previousTap.point.y) <= DOUBLE_TAP_REACH_PX;
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    lastPointerType = event.pointerType;
    const point = stagePointOfClient(event.clientX, event.clientY);
    pointers.set(event.pointerId, point);
    if (pointers.size === 2) {
      gesture = { kind: 'pinching', ...pinchShape() };
      return;
    }
    if (pointers.size === 1) gesture = { kind: 'pressed', pointerId: event.pointerId, start: point };
  }

  function movePinch(pinch: Extract<StageGesture, { kind: 'pinching' }>): void {
    const { distance, midpoint } = pinchShape();
    if (distance <= 0 || pinch.distance <= 0) return;
    const panned = panBy(zoom, midpoint.x - pinch.midpoint.x, midpoint.y - pinch.midpoint.y, stageSize());
    show(zoomAbout(panned, midpoint, distance / pinch.distance, stageSize()));
    gesture = { kind: 'pinching', distance, midpoint };
  }

  function onPointerMove(event: PointerEvent): void {
    if (!pointers.has(event.pointerId)) return;
    if (event.buttons === 0) {
      pointers.delete(event.pointerId);
      gesture = { kind: 'idle' };
      return;
    }
    const point = stagePointOfClient(event.clientX, event.clientY);
    pointers.set(event.pointerId, point);
    if (gesture.kind === 'pinching') {
      movePinch(gesture);
      return;
    }
    if (gesture.kind === 'pressed' && gesture.pointerId === event.pointerId) {
      const hasLeftSlop = Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) > PAN_SLOP_PX;
      if (!hasLeftSlop || !isZoomedIn(zoom)) return;
      stage.setPointerCapture(event.pointerId);
      gesture = { kind: 'panning', pointerId: event.pointerId, last: gesture.start };
    }
    if (gesture.kind !== 'panning' || gesture.pointerId !== event.pointerId) return;
    show(panBy(zoom, point.x - gesture.last.x, point.y - gesture.last.y, stageSize()));
    gesture = { ...gesture, last: point };
  }

  function onPointerEnd(event: PointerEvent): void {
    if (!pointers.delete(event.pointerId)) return;
    const wasTap = gesture.kind === 'pressed' && gesture.pointerId === event.pointerId && event.type === 'pointerup' && event.pointerType !== 'mouse';
    if (pointers.size === 0) gesture = { kind: 'idle' };
    if (pointers.size === 1 && gesture.kind === 'pinching') gesture = { kind: 'idle' };
    if (!wasTap) return;
    const point = stagePointOfClient(event.clientX, event.clientY);
    if (isDoubleTap(point)) show(toggleFitAbout(zoom, point, stageSize()));
  }

  function onWheel(event: WheelEvent): void {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      show(zoomAbout(zoom, stagePointOfClient(event.clientX, event.clientY), wheelZoomFactor(event.deltaY, WHEEL_ZOOM_STEP), stageSize()));
      return;
    }
    if (!isZoomedIn(zoom)) return;
    event.preventDefault();
    show(panBy(zoom, -event.deltaX, -event.deltaY, stageSize()));
  }

  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerEnd);
  stage.addEventListener('pointercancel', onPointerEnd);
  stage.addEventListener('wheel', onWheel, { passive: false });
  new ResizeObserver(() => show(panBy(zoom, 0, 0, stageSize()))).observe(stage);
  stage.addEventListener('dblclick', (event) => {
    event.preventDefault();
    if (lastPointerType !== 'mouse') return;
    show(toggleFitAbout(zoom, stagePointOfClient(event.clientX, event.clientY), stageSize()));
  });

  return {
    zoomAt: (mediaPoint, factor) => show(zoomAbout(zoom, stagePointOf(zoom, mediaPoint), factor, stageSize())),
    panBy: (deltaX, deltaY) => show(panBy(zoom, deltaX, deltaY, stageSize())),
    toggleFitAt: (mediaPoint) => show(toggleFitAbout(zoom, stagePointOf(zoom, mediaPoint), stageSize())),
    isZoomed: () => isZoomedIn(zoom),
  };
}
