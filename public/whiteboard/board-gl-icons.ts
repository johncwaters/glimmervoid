import { ICON_CATALOG } from '#shared/whiteboard-icons.ts';
import type { IconName } from '#shared/whiteboard-icons.ts';

interface IconPoint {
  x: number;
  y: number;
}

interface IconCircle {
  center: IconPoint;
  radius: number;
  isFilled: boolean;
}

interface IconStrokes {
  polylines: IconPoint[][];
  circles: IconCircle[];
}

const CURVE_STEPS = 8;
const ARC_STEPS_PER_QUARTER = 4;
const ROUND_CORNER_STEPS = 4;
const ELEMENT_PATTERN = /<(\w+)([^>]*)\/?>/g;
const ATTRIBUTE_PATTERN = /([\w-]+)="([^"]*)"/g;
const PATH_TOKEN_PATTERN = /[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g;

const strokesByName = new Map<IconName, IconStrokes>();

function attributesOf(source: string): Map<string, string> {
  return new Map([...source.matchAll(ATTRIBUTE_PATTERN)].map((match) => [match[1] ?? '', match[2] ?? '']));
}

function numberOf(attributes: ReadonlyMap<string, string>, name: string): number {
  return Number(attributes.get(name) ?? 0);
}

function pointsListOf(source: string): IconPoint[] {
  const numbers = source.trim().split(/[\s,]+/).map(Number);
  const points: IconPoint[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) points.push({ x: numbers[index] ?? 0, y: numbers[index + 1] ?? 0 });
  return points;
}

function ellipsePoints(center: IconPoint, radiusX: number, radiusY: number): IconPoint[] {
  const steps = ARC_STEPS_PER_QUARTER * 4;
  return Array.from({ length: steps + 1 }, (_, step) => {
    const angle = (step / steps) * Math.PI * 2;
    return { x: center.x + Math.cos(angle) * radiusX, y: center.y + Math.sin(angle) * radiusY };
  });
}

function roundedRectPoints(x: number, y: number, width: number, height: number, cornerRadius: number): IconPoint[] {
  const radius = Math.min(cornerRadius, width / 2, height / 2);
  if (radius <= 0) return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }, { x, y }];
  const corners = [
    { x: x + width - radius, y: y + radius, startAngle: -Math.PI / 2 },
    { x: x + width - radius, y: y + height - radius, startAngle: 0 },
    { x: x + radius, y: y + height - radius, startAngle: Math.PI / 2 },
    { x: x + radius, y: y + radius, startAngle: Math.PI },
  ];
  const points = corners.flatMap((corner) => Array.from({ length: ROUND_CORNER_STEPS + 1 }, (_, step) => {
    const angle = corner.startAngle + (step / ROUND_CORNER_STEPS) * (Math.PI / 2);
    return { x: corner.x + Math.cos(angle) * radius, y: corner.y + Math.sin(angle) * radius };
  }));
  const [first] = points;
  return first ? [...points, first] : points;
}

function cubicPoints(start: IconPoint, control1: IconPoint, control2: IconPoint, end: IconPoint): IconPoint[] {
  return Array.from({ length: CURVE_STEPS }, (_, step) => {
    const t = (step + 1) / CURVE_STEPS;
    const inverse = 1 - t;
    const a = inverse * inverse * inverse;
    const b = 3 * inverse * inverse * t;
    const c = 3 * inverse * t * t;
    const d = t * t * t;
    return { x: a * start.x + b * control1.x + c * control2.x + d * end.x, y: a * start.y + b * control1.y + c * control2.y + d * end.y };
  });
}

function vectorAngle(fromX: number, fromY: number, toX: number, toY: number): number {
  return Math.atan2(fromX * toY - fromY * toX, fromX * toX + fromY * toY);
}

function arcPoints(start: IconPoint, radiusXIn: number, radiusYIn: number, rotationDegrees: number, isLargeArc: boolean, isSweep: boolean, end: IconPoint): IconPoint[] {
  if (radiusXIn === 0 || radiusYIn === 0) return [end];
  const rotation = (rotationDegrees * Math.PI) / 180;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const halfDeltaX = (start.x - end.x) / 2;
  const halfDeltaY = (start.y - end.y) / 2;
  const primeX = cosine * halfDeltaX + sine * halfDeltaY;
  const primeY = -sine * halfDeltaX + cosine * halfDeltaY;
  const lambda = (primeX * primeX) / (radiusXIn * radiusXIn) + (primeY * primeY) / (radiusYIn * radiusYIn);
  const growth = lambda > 1 ? Math.sqrt(lambda) : 1;
  const radiusX = Math.abs(radiusXIn) * growth;
  const radiusY = Math.abs(radiusYIn) * growth;
  const numerator = radiusX * radiusX * radiusY * radiusY - radiusX * radiusX * primeY * primeY - radiusY * radiusY * primeX * primeX;
  const denominator = radiusX * radiusX * primeY * primeY + radiusY * radiusY * primeX * primeX;
  const sign = isLargeArc === isSweep ? -1 : 1;
  const factor = denominator === 0 ? 0 : sign * Math.sqrt(Math.max(0, numerator / denominator));
  const centerPrimeX = factor * ((radiusX * primeY) / radiusY);
  const centerPrimeY = factor * (-(radiusY * primeX) / radiusX);
  const centerX = cosine * centerPrimeX - sine * centerPrimeY + (start.x + end.x) / 2;
  const centerY = sine * centerPrimeX + cosine * centerPrimeY + (start.y + end.y) / 2;
  const startAngle = vectorAngle(1, 0, (primeX - centerPrimeX) / radiusX, (primeY - centerPrimeY) / radiusY);
  let sweep = vectorAngle((primeX - centerPrimeX) / radiusX, (primeY - centerPrimeY) / radiusY, (-primeX - centerPrimeX) / radiusX, (-primeY - centerPrimeY) / radiusY);
  if (!isSweep && sweep > 0) sweep -= Math.PI * 2;
  if (isSweep && sweep < 0) sweep += Math.PI * 2;
  const steps = Math.max(2, Math.ceil((Math.abs(sweep) / (Math.PI / 2)) * ARC_STEPS_PER_QUARTER));
  return Array.from({ length: steps }, (_, step) => {
    const angle = startAngle + (sweep * (step + 1)) / steps;
    const ellipseX = Math.cos(angle) * radiusX;
    const ellipseY = Math.sin(angle) * radiusY;
    return { x: cosine * ellipseX - sine * ellipseY + centerX, y: sine * ellipseX + cosine * ellipseY + centerY };
  });
}

function pathPolylines(pathData: string): IconPoint[][] {
  const tokens = pathData.match(PATH_TOKEN_PATTERN) ?? [];
  const polylines: IconPoint[][] = [];
  let current: IconPoint[] = [];
  let pen = { x: 0, y: 0 };
  let subpathStart = { x: 0, y: 0 };
  let lastCubicControl: IconPoint | null = null;
  let command = '';
  let cursor = 0;
  const nextNumber = (): number => Number(tokens[cursor++] ?? 0);
  const hasNumberNext = (): boolean => cursor < tokens.length && !/^[a-zA-Z]$/.test(tokens[cursor] ?? '');
  const lineTo = (point: IconPoint): void => {
    if (current.length === 0) current.push(pen);
    current.push(point);
    pen = point;
  };
  const finishSubpath = (): void => {
    if (current.length > 1) polylines.push(current);
    current = [];
  };
  while (cursor < tokens.length) {
    if (!hasNumberNext()) command = tokens[cursor++] ?? '';
    const isRelative = command === command.toLowerCase();
    const originX = isRelative ? pen.x : 0;
    const originY = isRelative ? pen.y : 0;
    const upper = command.toUpperCase();
    if (upper !== 'C' && upper !== 'S') lastCubicControl = null;
    switch (upper) {
      case 'M': {
        finishSubpath();
        pen = { x: originX + nextNumber(), y: originY + nextNumber() };
        subpathStart = pen;
        command = isRelative ? 'l' : 'L';
        break;
      }
      case 'L': lineTo({ x: originX + nextNumber(), y: originY + nextNumber() }); break;
      case 'H': lineTo({ x: originX + nextNumber(), y: pen.y }); break;
      case 'V': lineTo({ x: pen.x, y: originY + nextNumber() }); break;
      case 'C': {
        const control1 = { x: originX + nextNumber(), y: originY + nextNumber() };
        const control2 = { x: originX + nextNumber(), y: originY + nextNumber() };
        const end = { x: originX + nextNumber(), y: originY + nextNumber() };
        const start = pen;
        for (const point of cubicPoints(start, control1, control2, end)) lineTo(point);
        lastCubicControl = control2;
        break;
      }
      case 'S': {
        const control1 = lastCubicControl ? { x: pen.x * 2 - lastCubicControl.x, y: pen.y * 2 - lastCubicControl.y } : pen;
        const control2 = { x: originX + nextNumber(), y: originY + nextNumber() };
        const end = { x: originX + nextNumber(), y: originY + nextNumber() };
        const start = pen;
        for (const point of cubicPoints(start, control1, control2, end)) lineTo(point);
        lastCubicControl = control2;
        break;
      }
      case 'A': {
        const radiusX = nextNumber();
        const radiusY = nextNumber();
        const rotation = nextNumber();
        const isLargeArc = nextNumber() !== 0;
        const isSweep = nextNumber() !== 0;
        const end = { x: originX + nextNumber(), y: originY + nextNumber() };
        const start = pen;
        for (const point of arcPoints(start, radiusX, radiusY, rotation, isLargeArc, isSweep, end)) lineTo(point);
        break;
      }
      case 'Z': {
        lineTo(subpathStart);
        finishSubpath();
        break;
      }
      default: cursor += 1;
    }
  }
  finishSubpath();
  return polylines;
}

function strokesOfElement(tagName: string, attributes: ReadonlyMap<string, string>): IconStrokes {
  switch (tagName) {
    case 'path': return { polylines: pathPolylines(attributes.get('d') ?? ''), circles: [] };
    case 'line': return { polylines: [[{ x: numberOf(attributes, 'x1'), y: numberOf(attributes, 'y1') }, { x: numberOf(attributes, 'x2'), y: numberOf(attributes, 'y2') }]], circles: [] };
    case 'polyline': return { polylines: [pointsListOf(attributes.get('points') ?? '')], circles: [] };
    case 'polygon': {
      const points = pointsListOf(attributes.get('points') ?? '');
      const [first] = points;
      return { polylines: [first ? [...points, first] : points], circles: [] };
    }
    case 'rect': {
      const cornerRadius = numberOf(attributes, attributes.has('rx') ? 'rx' : 'ry');
      return { polylines: [roundedRectPoints(numberOf(attributes, 'x'), numberOf(attributes, 'y'), numberOf(attributes, 'width'), numberOf(attributes, 'height'), cornerRadius)], circles: [] };
    }
    case 'circle': {
      const center = { x: numberOf(attributes, 'cx'), y: numberOf(attributes, 'cy') };
      return { polylines: [], circles: [{ center, radius: numberOf(attributes, 'r'), isFilled: attributes.get('fill') === 'currentColor' }] };
    }
    case 'ellipse': {
      const center = { x: numberOf(attributes, 'cx'), y: numberOf(attributes, 'cy') };
      return { polylines: [ellipsePoints(center, numberOf(attributes, 'rx'), numberOf(attributes, 'ry'))], circles: [] };
    }
    default: return { polylines: [], circles: [] };
  }
}

function iconStrokesOf(name: IconName): IconStrokes {
  const known = strokesByName.get(name);
  if (known) return known;
  const strokes: IconStrokes = { polylines: [], circles: [] };
  for (const source of ICON_CATALOG[name].elements) {
    for (const match of source.matchAll(ELEMENT_PATTERN)) {
      const element = strokesOfElement(match[1] ?? '', attributesOf(match[2] ?? ''));
      strokes.polylines.push(...element.polylines);
      strokes.circles.push(...element.circles);
    }
  }
  strokesByName.set(name, strokes);
  return strokes;
}

export { iconStrokesOf };
