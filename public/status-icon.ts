import type { StatusIcon } from '#shared/state-icons.ts';
import { STATUS_ICON_SHAPES } from '#shared/state-icons.ts';
import { createSvgIcon, createSvgShape } from './svg-dom.ts';

type Layers = readonly SVGSVGElement[];
type Choreography = (outgoing: Layers, incoming: Layers) => Promise<unknown>;

const SETTLE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const SWAP = 'cubic-bezier(0.4, 0, 0.2, 1)';
const BRAKE = 'cubic-bezier(0.1, 0.8, 0.3, 1)';
const SPRING = 'cubic-bezier(0.2, 0.9, 0.3, 1)';
const COLOR_BLEND_MS = 460;
const DOT_ORIGIN = '50% 87.5%';
const QUARTER_TURN = 90;

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const settledColorByContainer = new WeakMap<HTMLElement, string>();
const finishByStack = new WeakMap<HTMLElement, () => void>();
const colorBlendByStack = new WeakMap<HTMLElement, Animation>();

function createShapeLayer(tag: string, attributes: Readonly<Record<string, string>>): SVGSVGElement {
  const { class: animationClass, ...shapeAttributes } = attributes;
  const layer = createSvgIcon(16, 16);
  if (animationClass !== undefined) layer.classList.add(animationClass);
  layer.append(createSvgShape(tag, shapeAttributes));
  return layer;
}

function createLayers(icon: StatusIcon): SVGSVGElement[] {
  return STATUS_ICON_SHAPES[icon].map((shape) => createShapeLayer(shape.tag, shape.attributes));
}

function createStatusIcon(icon: StatusIcon): HTMLSpanElement {
  const stack = document.createElement('span');
  stack.className = 'status-icon';
  stack.dataset.icon = icon;
  stack.append(...createLayers(icon));
  return stack;
}

function isStatusIcon(value: string | undefined): value is StatusIcon {
  return value !== undefined && Object.hasOwn(STATUS_ICON_SHAPES, value);
}

function play(target: Element | undefined, keyframes: Keyframe[], options: KeyframeAnimationOptions): Promise<unknown> {
  if (!target) return Promise.resolve();
  return target.animate(keyframes, { fill: 'both', easing: SETTLE, ...options }).finished.catch(() => undefined);
}

function playEach(layers: Layers, keyframes: Keyframe[], options: KeyframeAnimationOptions): Promise<unknown> {
  return Promise.all(layers.map((layer) => play(layer, keyframes, options)));
}

function draw(layer: SVGSVGElement | undefined, from: number, to: number, options: KeyframeAnimationOptions): Promise<unknown> {
  const shape = layer?.firstElementChild;
  if (!(shape instanceof SVGElement)) return Promise.resolve();
  shape.setAttribute('pathLength', '1');
  return play(shape, [{ strokeDasharray: '1 3', strokeDashoffset: from }, { strokeDasharray: '1 3', strokeDashoffset: to }], options);
}

const withClass = (layers: Layers, className: string) => layers.find((layer) => layer.classList.contains(className));
const withShape = (layers: Layers, tag: string) => layers.find((layer) => layer.firstElementChild?.tagName === tag);
const withoutClass = (layers: Layers, className: string) => layers.filter((layer) => !layer.classList.contains(className));

function spinAngleOf(layer: SVGSVGElement): number {
  const transform = getComputedStyle(layer).transform;
  if (!transform || transform === 'none') return 0;
  const matrix = new DOMMatrixReadOnly(transform);
  return Math.atan2(matrix.b, matrix.a) * (180 / Math.PI);
}

const swap: Choreography = (outgoing, incoming) => Promise.all([
  playEach(outgoing, [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.6)', opacity: 0 }], { duration: 200, easing: 'ease-in' }),
  playEach(incoming, [{ transform: 'scale(0.6)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 280, delay: 110 }),
]);

const popIn = (layer: SVGSVGElement | undefined, delay: number) => play(layer, [
  { transform: 'scale(0.3)', opacity: 0 },
  { transform: 'scale(1.16)', opacity: 1, offset: 0.6 },
  { transform: 'scale(1)', opacity: 1 },
], { duration: 350, delay });

const shrinkAway = (layer: SVGSVGElement | undefined) => play(layer, [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.2)', opacity: 0 }], { duration: 230, easing: 'ease-in' });

function brakeThenFold(outgoing: Layers, incoming: Layers): Promise<unknown> {
  const angle = outgoing[0] ? spinAngleOf(outgoing[0]) : 0;
  const rest = Math.round(angle / QUARTER_TURN) * QUARTER_TURN;
  const restingOpacity = (layer: SVGSVGElement) => (layer.classList.contains('status-icon-spin-blur') ? 0 : 1);
  for (const layer of incoming) layer.style.opacity = '0';
  const brake = Promise.all(outgoing.map((layer) => play(layer, [
    { transform: `rotate(${angle}deg)`, opacity: getComputedStyle(layer).opacity },
    { transform: `rotate(${rest}deg)`, opacity: restingOpacity(layer) },
  ], { duration: 240, easing: BRAKE })));
  return brake.then(() => {
    for (const layer of incoming) layer.style.opacity = '';
    return Promise.all([
      ...outgoing.map((layer) => play(layer, [
        { transform: `rotate(${rest}deg) scale(1)`, opacity: restingOpacity(layer) },
        { transform: `rotate(${rest}deg) scale(0.55)`, opacity: 0 },
      ], { duration: 300, easing: SWAP })),
      playEach(incoming, [
        { transform: 'scale(0.7, 0.25)', opacity: 0 },
        { transform: 'scale(1, 1.06)', opacity: 1, offset: 0.7 },
        { transform: 'scale(1)', opacity: 1 },
      ], { duration: 340, delay: 40, easing: SPRING }),
    ]);
  });
}

const CHOREOGRAPHY: Partial<Record<`${StatusIcon}>${StatusIcon}`, Choreography>> = {
  'not-started>starting': (outgoing, incoming) => Promise.all([
    playEach(outgoing, [{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: 'linear' }),
    playEach(withoutClass(incoming, 'status-icon-spin-blur'), [{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'linear' }),
  ]),
  'not-started>idle': (outgoing, incoming) => Promise.all([
    playEach(outgoing, [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.7)', opacity: 0 }], { duration: 340, easing: SWAP }),
    playEach(incoming, [{ transform: 'scale(0.55)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 340, delay: 80, easing: SWAP }),
  ]),
  'starting>idle': brakeThenFold,
  'starting>working': (outgoing, incoming) => Promise.all([
    ...outgoing.map((layer) => {
      const angle = spinAngleOf(layer);
      return play(layer, [
        { transform: `rotate(${angle}deg) scale(1)`, opacity: getComputedStyle(layer).opacity },
        { transform: `rotate(${angle}deg) scale(0.55)`, opacity: 0 },
      ], { duration: 260, easing: 'ease-in' });
    }),
    popIn(withClass(incoming, 'status-icon-beat'), 160),
  ]),
  'working>complete': (outgoing, incoming) => Promise.all([shrinkAway(withClass(outgoing, 'status-icon-beat')), draw(incoming[0], 1, 0, { duration: 320, delay: 160 })]),
  'working>failed': (outgoing, incoming) => Promise.all([shrinkAway(withClass(outgoing, 'status-icon-beat')), draw(incoming[0], 1, 0, { duration: 300, delay: 150 })]),
  'working>needs-input': (outgoing, incoming) => Promise.all([
    play(withClass(outgoing, 'status-icon-beat'), [
      { transform: 'none', opacity: 1 },
      { transform: 'translateY(37.5%) scale(0.34)', opacity: 1, offset: 0.9 },
      { transform: 'translateY(37.5%) scale(0.34)', opacity: 0 },
    ], { duration: 320 }),
    play(withShape(incoming, 'circle'), [{ opacity: 0 }, { opacity: 0, offset: 0.85 }, { opacity: 1 }], { duration: 320, easing: 'linear' }),
    draw(withShape(incoming, 'path'), 1, 0, { duration: 300, delay: 260 }),
  ]),
  'needs-input>working': (outgoing, incoming) => {
    const dot = withShape(outgoing, 'circle');
    if (dot) dot.style.transformOrigin = DOT_ORIGIN;
    return Promise.all([
      draw(withShape(outgoing, 'path'), 0, 1, { duration: 200, easing: 'ease-in' }),
      play(dot, [
        { transform: 'none', opacity: 1 },
        { transform: 'translateY(-37.5%) scale(2.95)', opacity: 1, offset: 0.95 },
        { transform: 'translateY(-37.5%) scale(2.95)', opacity: 0 },
      ], { duration: 320, delay: 140 }),
      play(withClass(incoming, 'status-icon-beat'), [{ opacity: 0 }, { opacity: 0, offset: 0.9 }, { opacity: 1 }], { duration: 470, easing: 'linear' }),
    ]);
  },
  'working>idle': (outgoing, incoming) => Promise.all([
    play(withClass(outgoing, 'status-icon-beat'), [{ transform: 'scale(1, 1)', opacity: 1 }, { transform: 'scale(0.35, 1.15)', opacity: 0 }], { duration: 220, easing: 'ease-in' }),
    playEach(incoming, [{ transform: 'scale(0.1, 0.8)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 320, delay: 120 }),
  ]),
  'idle>working': (outgoing, incoming) => Promise.all([
    playEach(outgoing, [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.1, 0.8)', opacity: 0 }], { duration: 220, easing: 'ease-in' }),
    play(withClass(incoming, 'status-icon-beat'), [
      { transform: 'scale(0.35, 1.15)', opacity: 0 },
      { transform: 'scale(1.12, 1)', opacity: 1, offset: 0.6 },
      { transform: 'scale(1)', opacity: 1 },
    ], { duration: 360, delay: 120 }),
  ]),
  'working>monitoring': (outgoing, incoming) => Promise.all([
    play(withClass(outgoing, 'status-icon-beat'), [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1.3, 0.15)', opacity: 0 }], { duration: 220, easing: 'ease-in' }),
    playEach(incoming, [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: 300, delay: 160 }),
  ]),
  'monitoring>working': (outgoing, incoming) => Promise.all([
    playEach(outgoing, [{ transform: 'scaleY(1)' }, { transform: 'scaleY(0)' }], { duration: 200, easing: 'ease-in' }),
    popIn(withClass(incoming, 'status-icon-beat'), 170),
  ]),
  'complete>exited': (outgoing, incoming) => Promise.all([
    draw(outgoing[0], 0, -1, { duration: 220, easing: 'ease-in' }),
    draw(incoming[0], 1, 0, { duration: 380, delay: 140 }),
  ]),
};

function blendColorFrom(container: HTMLElement, stack: HTMLElement) {
  colorBlendByStack.get(stack)?.cancel();
  const settledColor = settledColorByContainer.get(container);
  if (!settledColor) return;
  stack.style.setProperty('--status-icon-from', settledColor);
  const blend = stack.animate([{ '--status-icon-blend': '0%' }, { '--status-icon-blend': '100%' }], { duration: COLOR_BLEND_MS, easing: SWAP });
  colorBlendByStack.set(stack, blend);
  blend.finished.then(() => stack.style.removeProperty('--status-icon-from'), () => undefined);
}

function rememberSettledColor(container: HTMLElement) {
  if (!container.isConnected) return;
  settledColorByContainer.set(container, getComputedStyle(container).color);
}

function cancelScriptedAnimations(element: Element) {
  for (const animation of element.getAnimations({ subtree: true })) {
    if (animation instanceof CSSAnimation || animation instanceof CSSTransition) continue;
    animation.cancel();
  }
}

function transitionStack(container: HTMLElement, stack: HTMLElement, from: StatusIcon, to: StatusIcon) {
  finishByStack.get(stack)?.();
  const outgoing = [...stack.children].filter((child): child is SVGSVGElement => child instanceof SVGSVGElement);
  const incoming = createLayers(to);
  for (const layer of outgoing) layer.dataset.leaving = '';
  const outgoingPing = withClass(outgoing, 'status-icon-ping');
  if (outgoingPing) {
    cancelScriptedAnimations(outgoingPing);
    outgoingPing.style.opacity = '0';
  }
  stack.dataset.icon = to;
  blendColorFrom(container, stack);
  stack.append(...incoming);
  let isFinished = false;
  const finish = () => {
    if (isFinished) return;
    isFinished = true;
    for (const layer of outgoing) layer.remove();
    for (const layer of incoming) {
      cancelScriptedAnimations(layer);
      layer.style.opacity = '';
    }
    finishByStack.delete(stack);
    rememberSettledColor(container);
  };
  finishByStack.set(stack, finish);
  (CHOREOGRAPHY[`${from}>${to}`] ?? swap)(outgoing, incoming).then(finish, finish);
}

function canAnimate(container: HTMLElement): boolean {
  return container.isConnected && !document.hidden && reducedMotion?.matches !== true && typeof container.animate === 'function';
}

export function paintStatusIcon(container: HTMLElement, icon: StatusIcon): void {
  const previous = container.dataset.icon;
  if (previous === icon) return;
  container.dataset.icon = icon;
  const stack = container.querySelector(':scope > .status-icon');
  if (!isStatusIcon(previous) || !(stack instanceof HTMLElement) || !canAnimate(container)) {
    if (stack instanceof HTMLElement) finishByStack.get(stack)?.();
    container.replaceChildren(createStatusIcon(icon));
    rememberSettledColor(container);
    return;
  }
  transitionStack(container, stack, previous, icon);
}
