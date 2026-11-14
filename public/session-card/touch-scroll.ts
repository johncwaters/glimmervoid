import type { Terminal } from '@xterm/xterm';
import type { InertiaState, VelocitySample } from './touch-scroll-core.ts';
import {
  beginInertia,
  cellHeightFromElement,
  isLongPress,
  isScrollGesture,
  isWithinTapSlop,
  MAX_WHEEL_ROWS_PER_STEP,
  pushVelocitySample,
  releaseVelocity,
  scrollLinesForDrag,
  shouldSendWheelReport,
  stepInertia,
} from './touch-scroll-core.ts';
import { LONG_PRESS_MS } from './touch-select-core.ts';

const SELECTION_LAYER_SELECTOR = '.terminal-select-mirror';

const DOM_DELTA_LINE = 1;

interface TerminalWithPrivateViewport extends Terminal {
  _core?: { _viewport?: { handleTouchScroll?: unknown } };
}

function hasNativeTouchScroll(term: Terminal) {
  return typeof (term as TerminalWithPrivateViewport)._core?._viewport?.handleTouchScroll === 'function';
}

function findTouch(touchList: TouchList, identifier: number) {
  for (const touch of touchList) {
    if (touch.identifier === identifier) return touch;
  }
  return null;
}

export function wireTouchScroll(termWrap: HTMLElement, term: Terminal, onLongPress: (clientX: number, clientY: number) => void) {
  if (hasNativeTouchScroll(term)) return;

  const isPhoneLayout = () => document.documentElement.dataset.layout === 'phone';

  let activeTouchId: number | null = null;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let touchStartedAtMs = 0;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let didLongPress = false;
  let isScrolling = false;
  let pendingPx = 0;
  let velocitySamples: VelocitySample[] = [];
  let inertiaState: InertiaState | null = null;
  let inertiaFrame: number | null = null;

  const cancelInertia = () => {
    if (inertiaFrame !== null) cancelAnimationFrame(inertiaFrame);
    inertiaFrame = null;
    inertiaState = null;
  };

  const routesToApplication = () =>
    shouldSendWheelReport(term.buffer?.active?.type, term.modes?.mouseTrackingMode);

  const measureCellHeight = () => {
    const screen = term.element?.querySelector('.xterm-screen');
    return cellHeightFromElement(screen?.clientHeight || term.element?.clientHeight || 0, term.rows);
  };

  const cancelLongPress = () => {
    if (longPressTimer !== null) clearTimeout(longPressTimer);
    longPressTimer = null;
  };

  const fireLongPress = () => {
    longPressTimer = null;
    if (activeTouchId === null || isScrolling || !isPhoneLayout()) return;
    const heldMs = performance.now() - touchStartedAtMs;
    if (!isLongPress({ deltaXPx: lastX - startX, deltaYPx: lastY - startY, heldMs, longPressMs: LONG_PRESS_MS })) return;
    didLongPress = true;
    onLongPress(lastX, lastY);
  };

  const endGesture = () => {
    cancelLongPress();
    activeTouchId = null;
    isScrolling = false;
    pendingPx = 0;
    velocitySamples = [];
  };

  const dispatchWheelNotches = (scrollLines: number, clientX: number, clientY: number) => {
    const deltaY = scrollLines < 0 ? -1 : 1;
    for (let notch = 0; notch < Math.abs(scrollLines); notch++) {
      term.element?.dispatchEvent(new WheelEvent('wheel', {
        deltaY,
        deltaMode: DOM_DELTA_LINE,
        clientX,
        clientY,
        bubbles: true,
        cancelable: true,
      }));
    }
  };

  const runInertiaFrame = () => {
    inertiaFrame = null;
    if (!inertiaState) return;
    if (!termWrap.isConnected || !isPhoneLayout() || routesToApplication()) {
      cancelInertia();
      return;
    }

    const viewportBefore = term.buffer?.active?.viewportY;
    const { scrollLines, state } = stepInertia(inertiaState, performance.now());
    inertiaState = state;
    if (scrollLines !== 0) term.scrollLines(scrollLines);
    if (!inertiaState) return;
    if (scrollLines !== 0 && term.buffer?.active?.viewportY === viewportBefore) {
      cancelInertia();
      return;
    }
    inertiaFrame = requestAnimationFrame(runInertiaFrame);
  };

  const startInertia = (velocityPxPerMs: number, startedAtMs: number, carriedPx: number) => {
    inertiaState = beginInertia({
      velocityPxPerMs,
      startedAtMs,
      cellHeightPx: measureCellHeight(),
      pendingPx: carriedPx,
    });
    if (!inertiaState) return;
    inertiaFrame = requestAnimationFrame(runInertiaFrame);
  };

  termWrap.addEventListener('contextmenu', (event) => {
    if (activeTouchId === null) return;
    event.stopPropagation();
  }, true);

  termWrap.addEventListener('touchstart', (event) => {
    cancelInertia();

    didLongPress = false;
    const startsOnSelectionLayer = event.target instanceof Element && event.target.closest(SELECTION_LAYER_SELECTOR) !== null;
    if (!isPhoneLayout() || event.touches.length !== 1 || startsOnSelectionLayer) {
      endGesture();
      return;
    }
    const touch = event.touches[0];
    activeTouchId = touch.identifier;
    startX = touch.clientX;
    startY = touch.clientY;
    lastX = touch.clientX;
    lastY = touch.clientY;
    touchStartedAtMs = performance.now();
    longPressTimer = setTimeout(fireLongPress, LONG_PRESS_MS);
    isScrolling = false;
    pendingPx = 0;
    velocitySamples = [];
  }, { passive: true });

  termWrap.addEventListener('touchmove', (event) => {
    if (activeTouchId === null || didLongPress || !isPhoneLayout()) return;
    const touch = findTouch(event.touches, activeTouchId);
    if (!touch) return;

    if (!isScrolling) {
      lastX = touch.clientX;
      lastY = touch.clientY;
      if (!isWithinTapSlop(touch.clientX - startX, touch.clientY - startY)) cancelLongPress();
      if (!isScrollGesture(touch.clientX - startX, touch.clientY - startY)) return;
      isScrolling = true;

      lastY = touch.clientY;
      pendingPx = 0;
      velocitySamples = pushVelocitySample([], touch.clientY, event.timeStamp);
    }

    if (event.cancelable) event.preventDefault();

    pendingPx += touch.clientY - lastY;
    lastY = touch.clientY;
    velocitySamples = pushVelocitySample(velocitySamples, touch.clientY, event.timeStamp);

    const sendsToApplication = routesToApplication();
    const { scrollLines, remainderPx } = scrollLinesForDrag(
      pendingPx,
      measureCellHeight(),
      sendsToApplication ? MAX_WHEEL_ROWS_PER_STEP : undefined,
    );
    pendingPx = remainderPx;
    if (scrollLines === 0) return;
    if (sendsToApplication) {
      dispatchWheelNotches(scrollLines, touch.clientX, touch.clientY);
      return;
    }
    term.scrollLines(scrollLines);
  }, { passive: false });

  termWrap.addEventListener('touchend', (event) => {
    if (didLongPress) {
      didLongPress = false;
      if (event.cancelable) event.preventDefault();
      endGesture();
      return;
    }
    if (!isScrolling || routesToApplication()) {
      endGesture();
      return;
    }

    velocitySamples = pushVelocitySample(velocitySamples, lastY, event.timeStamp);
    const velocityPxPerMs = releaseVelocity(velocitySamples);
    const carriedPx = pendingPx;
    endGesture();
    if (velocityPxPerMs === 0) return;

    startInertia(velocityPxPerMs, performance.now(), carriedPx);
  }, { passive: false });

  termWrap.addEventListener('touchcancel', () => {
    cancelInertia();
    endGesture();
  }, { passive: true });
}
