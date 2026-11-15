import { prefersReducedMotion } from './dom.ts';

const NEON_PALETTE = ['#ff2bd6', '#ffe53b', '#2bf0ff', '#3bff7a'];
const OCEAN_PALETTE = ['#3b82f6', '#22d3ee', '#8b5cf6', '#60a5fa', '#a78bfa'];
const LIFE_CELL_PX = 9;
const LIFE_STEP_MS = 140;
const LIFE_STALE_GENERATIONS = 24;
const LIFE_SEED_DENSITY = 0.22;
const RAIN_STEP_MS = 33;
const SPLASH_LIFETIME_STEPS = 18;
const RADAR_STEP_MS = 16;
const RADAR_TURN_MS = 3200;
const RADAR_TRAIL_RADIANS = 1.4;
const RADAR_TRAIL_SLICES = 36;
const RADAR_BLIP_COUNT = 8;
const RADAR_BLIP_SWEEPS = 4;
const RADAR_GLOW_DECAY = 0.982;
const RADAR_NOISE_DOTS = 14;
const FULL_TURN = Math.PI * 2;

interface Simulation {
  step: () => void;
  draw: (context: CanvasRenderingContext2D) => void;
  stepMs: number;
}

function pickIndex(length: number): number {
  return Math.floor(Math.random() * length);
}

function createLife(width: number, height: number): Simulation {
  const columns = Math.max(1, Math.floor(width / LIFE_CELL_PX));
  const rows = Math.max(1, Math.floor(height / LIFE_CELL_PX));
  let cells = new Uint8Array(columns * rows);
  let nextCells = new Uint8Array(columns * rows);
  const neighborCounts = new Uint8Array(NEON_PALETTE.length + 1);
  const populationHistory: number[] = [];

  function seed() {
    for (let index = 0; index < cells.length; index++) cells[index] = Math.random() < LIFE_SEED_DENSITY ? 1 + pickIndex(NEON_PALETTE.length) : 0;
    populationHistory.length = 0;
  }

  function nextCell(column: number, row: number): number {
    neighborCounts.fill(0);
    let liveNeighbors = 0;
    for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
      const neighborRow = (row + rowOffset + rows) % rows;
      for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
        if (rowOffset === 0 && columnOffset === 0) continue;
        const colorIndex = cells[neighborRow * columns + ((column + columnOffset + columns) % columns)];
        if (colorIndex === 0) continue;
        liveNeighbors++;
        neighborCounts[colorIndex]++;
      }
    }
    const current = cells[row * columns + column];
    if (current !== 0) return liveNeighbors === 2 || liveNeighbors === 3 ? current : 0;
    if (liveNeighbors !== 3) return 0;
    let dominantColorIndex = 1;
    for (let colorIndex = 2; colorIndex < neighborCounts.length; colorIndex++) {
      if (neighborCounts[colorIndex] > neighborCounts[dominantColorIndex]) dominantColorIndex = colorIndex;
    }
    return dominantColorIndex;
  }

  function isStale(population: number): boolean {
    populationHistory.push(population);
    if (populationHistory.length > LIFE_STALE_GENERATIONS) populationHistory.shift();
    if (population < cells.length * 0.03) return true;
    if (populationHistory.length < LIFE_STALE_GENERATIONS) return false;
    return Math.max(...populationHistory) - Math.min(...populationHistory) <= 2;
  }

  function step() {
    let population = 0;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const colorIndex = nextCell(column, row);
        nextCells[row * columns + column] = colorIndex;
        if (colorIndex !== 0) population++;
      }
    }
    [cells, nextCells] = [nextCells, cells];
    if (isStale(population)) seed();
  }

  function draw(context: CanvasRenderingContext2D) {
    context.clearRect(0, 0, width, height);
    for (let index = 0; index < cells.length; index++) {
      if (cells[index] === 0) continue;
      context.fillStyle = NEON_PALETTE[cells[index] - 1];
      context.fillRect((index % columns) * LIFE_CELL_PX, Math.floor(index / columns) * LIFE_CELL_PX, LIFE_CELL_PX - 1, LIFE_CELL_PX - 1);
    }
  }

  seed();
  return { step, draw, stepMs: LIFE_STEP_MS };
}

function createRain(width: number, height: number): Simulation {
  const dropCount = Math.max(4, Math.round(width / 9));
  const newDrop = (canStartInView: boolean) => ({
    x: Math.random() * width,
    y: canStartInView ? Math.random() * height : -Math.random() * height,
    length: 6 + Math.random() * 12,
    speed: 1.2 + Math.random() * 2.6,
    color: OCEAN_PALETTE[pickIndex(OCEAN_PALETTE.length)],
  });
  const drops = Array.from({ length: dropCount }, () => newDrop(true));
  const splashes: { x: number; color: string; age: number }[] = [];

  function step() {
    for (const [index, drop] of drops.entries()) {
      drop.y += drop.speed;
      if (drop.y - drop.length < height) continue;
      splashes.push({ x: drop.x, color: drop.color, age: 0 });
      drops[index] = newDrop(false);
    }
    for (const splash of splashes) splash.age += 1;
    while (splashes.length > 0 && splashes[0].age > SPLASH_LIFETIME_STEPS) splashes.shift();
  }

  function draw(context: CanvasRenderingContext2D) {
    context.clearRect(0, 0, width, height);
    context.lineWidth = 1.5;
    context.globalAlpha = 0.85;
    for (const drop of drops) {
      context.strokeStyle = drop.color;
      context.beginPath();
      context.moveTo(drop.x, drop.y - drop.length);
      context.lineTo(drop.x, drop.y);
      context.stroke();
    }
    for (const splash of splashes) {
      context.fillStyle = splash.color;
      context.globalAlpha = 1 - splash.age / SPLASH_LIFETIME_STEPS;
      for (const direction of [-1, 0, 1]) context.fillRect(splash.x + direction * splash.age * 0.7, height - 2 - (splash.age % 4), 1.5, 1.5);
    }
    context.globalAlpha = 1;
  }

  return { step, draw, stepMs: RAIN_STEP_MS };
}

function createRadar(width: number, height: number): Simulation {
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.max(1, Math.min(width, height) / 2 - 3);
  const sweepStep = (FULL_TURN * RADAR_STEP_MS) / RADAR_TURN_MS;
  let sweepAngle = Math.random() * FULL_TURN;
  const newBlip = (slot: number) => ({ angle: ((slot + 0.15 + Math.random() * 0.7) / RADAR_BLIP_COUNT) * FULL_TURN, distance: 0.18 + Math.random() * 0.76, label: `#${380 + pickIndex(60)}`, glow: Math.random(), sweepsLeft: 1 + pickIndex(RADAR_BLIP_SWEEPS) });
  const blips = Array.from({ length: RADAR_BLIP_COUNT }, (_, slot) => newBlip(slot));

  function step() {
    const previousAngle = sweepAngle;
    sweepAngle = (sweepAngle + sweepStep) % FULL_TURN;
    for (const [index, blip] of blips.entries()) {
      blip.glow *= RADAR_GLOW_DECAY;
      const isCrossedThisStep = previousAngle < sweepAngle ? blip.angle > previousAngle && blip.angle <= sweepAngle : blip.angle > previousAngle || blip.angle <= sweepAngle;
      if (!isCrossedThisStep) continue;
      blip.sweepsLeft -= 1;
      blip.glow = 1;
      if (blip.sweepsLeft < 0) blips[index] = { ...newBlip(index), glow: 0 };
    }
  }

  function pointAt(angle: number, distance: number): [number, number] {
    return [centerX + Math.sin(angle) * distance * radius, centerY - Math.cos(angle) * distance * radius];
  }

  function draw(context: CanvasRenderingContext2D) {
    const color = getComputedStyle(context.canvas).color;
    context.clearRect(0, 0, width, height);
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 1;
    context.globalAlpha = 0.22;
    for (const ringFraction of [0.25, 0.5, 0.75, 1]) {
      context.beginPath();
      context.arc(centerX, centerY, radius * ringFraction, 0, FULL_TURN);
      context.stroke();
    }
    context.beginPath();
    context.moveTo(centerX - radius, centerY);
    context.lineTo(centerX + radius, centerY);
    context.moveTo(centerX, centerY - radius);
    context.lineTo(centerX, centerY + radius);
    context.stroke();
    for (let tick = 0; tick < 72; tick++) {
      const tickAngle = (tick / 72) * FULL_TURN;
      const [outerX, outerY] = pointAt(tickAngle, 1);
      const [innerX, innerY] = pointAt(tickAngle, tick % 6 === 0 ? 0.92 : 0.96);
      context.beginPath();
      context.moveTo(innerX, innerY);
      context.lineTo(outerX, outerY);
      context.stroke();
    }
    for (let slice = 0; slice < RADAR_TRAIL_SLICES; slice++) {
      const sliceEnd = sweepAngle - (slice / RADAR_TRAIL_SLICES) * RADAR_TRAIL_RADIANS;
      const sliceStart = sliceEnd - RADAR_TRAIL_RADIANS / RADAR_TRAIL_SLICES;
      context.globalAlpha = 0.42 * (1 - slice / RADAR_TRAIL_SLICES) ** 2;
      context.beginPath();
      context.moveTo(centerX, centerY);
      context.arc(centerX, centerY, radius, sliceStart - Math.PI / 2, sliceEnd - Math.PI / 2);
      context.closePath();
      context.fill();
    }
    context.globalAlpha = 0.95;
    context.lineWidth = 1.5;
    const [edgeX, edgeY] = pointAt(sweepAngle, 1);
    context.beginPath();
    context.moveTo(centerX, centerY);
    context.lineTo(edgeX, edgeY);
    context.stroke();
    for (let dot = 0; dot < RADAR_NOISE_DOTS; dot++) {
      const [noiseX, noiseY] = pointAt(Math.random() * FULL_TURN, Math.sqrt(Math.random()));
      context.globalAlpha = Math.random() * 0.35;
      context.fillRect(noiseX, noiseY, 1, 1);
    }
    context.font = '700 10px ui-monospace, monospace';
    for (const blip of blips) {
      const [blipX, blipY] = pointAt(blip.angle, blip.distance);
      context.globalAlpha = 0.18 + 0.82 * blip.glow;
      context.beginPath();
      context.arc(blipX, blipY, 2 + blip.glow * 2.5, 0, FULL_TURN);
      context.fill();
      if (blip.glow > 0.12) {
        context.globalAlpha = blip.glow * 0.6;
        context.lineWidth = 1;
        context.beginPath();
        context.arc(blipX, blipY, 4 + (1 - blip.glow) * 14, 0, FULL_TURN);
        context.stroke();
      }
      if (blip.glow < 0.25) continue;
      context.globalAlpha = blip.glow;
      context.fillText(blip.label, blipX + 6, blipY - 5);
    }
    context.globalAlpha = 1;
  }

  return { step, draw, stepMs: RADAR_STEP_MS };
}

const SIMULATIONS_BY_KIND = { life: createLife, rain: createRain, radar: createRadar };
export type AmbientKind = keyof typeof SIMULATIONS_BY_KIND;

export function isAmbientKind(kind: string | undefined): kind is AmbientKind {
  return kind !== undefined && Object.hasOwn(SIMULATIONS_BY_KIND, kind);
}

export function runAmbientWhileVisible(canvas: HTMLCanvasElement, kind: AmbientKind): () => void {
  const context = canvas.getContext('2d');
  if (!context) return () => {};
  let simulation: Simulation | null = null;
  let isOnScreen = false;
  let lastStepAt = 0;
  let pendingFrame: number | null = null;
  const isAnimated = !prefersReducedMotion();

  const rebuildForSize = (width: number, height: number) => {
    if (width < 1 || height < 1) {
      simulation = null;
      return;
    }
    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    simulation = SIMULATIONS_BY_KIND[kind](width, height);
    simulation.draw(context);
  };
  const tick = (now: number) => {
    pendingFrame = null;
    if (!simulation || !isOnScreen || document.hidden) return;
    if (now - lastStepAt >= simulation.stepMs) {
      simulation.step();
      simulation.draw(context);
      lastStepAt = now;
    }
    pendingFrame = requestAnimationFrame(tick);
  };
  const resume = () => {
    if (isAnimated && pendingFrame === null && simulation && isOnScreen && !document.hidden) pendingFrame = requestAnimationFrame(tick);
  };

  new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    rebuildForSize(Math.round(width), Math.round(height));
    resume();
  }).observe(canvas);
  new IntersectionObserver(([entry]) => {
    isOnScreen = entry.isIntersecting;
    resume();
  }).observe(canvas);
  document.addEventListener('visibilitychange', resume);
  return () => simulation?.draw(context);
}
