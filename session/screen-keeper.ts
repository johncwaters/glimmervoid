import { createRequire } from "node:module";
import headless from "@xterm/headless";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import { serializeMouseEncoding, updateMouseEncoding } from "./core/mouse-encoding-core.ts";
import type { MouseEncoding } from "./core/mouse-encoding-core.ts";
import {
  SCREEN_KEEPER_ATTACH_SCROLLBACK,
  SCREEN_KEEPER_PENDING_CAP,
  SCREEN_KEEPER_SCROLLBACK,
  SCREEN_KEEPER_SLICE_JOINER,
  SCREEN_KEEPER_SLICE_ROWS,
  isKeeperOverrun,
  pendingResizes,
  planDeepSlices,
} from "./core/screen-keeper-core.ts";
import type { ResizeMarker } from "./core/screen-keeper-core.ts";

const { Terminal } = headless;

interface SerializeOptions {
  scrollback?: number;
  range?: { start: number; end: number };
  excludeAltBuffer?: boolean;
  excludeModes?: boolean;
}

interface SerializerPort {
  activate(terminal: unknown): void;
  serialize(options?: SerializeOptions): string;
  dispose(): void;
}

interface SerializeAddonModule {
  SerializeAddon: new () => SerializerPort;
}

const { SerializeAddon } = createRequire(import.meta.url)("@xterm/addon-serialize") as SerializeAddonModule;

interface DeepScreen {
  data: string;
  parsedOffset: number;
}

interface ScreenKeeper {
  push(chunk: string): boolean;
  resize(cols: number, rows: number): void;
  parsedOffset(): number;
  isOverrun(): boolean;
  isDrained(): boolean;
  serialize(): string;
  serializeDeep(): Promise<DeepScreen | null>;
  dispose(): void;
}

interface ScreenKeeperOptions {
  pendingCap?: number;
  sliceRows?: number;
}

type ScreenKeeperFactory = (size: { cols: number; rows: number }) => ScreenKeeper;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

function createScreenKeeper(
  { cols, rows }: { cols: number; rows: number },
  { pendingCap = SCREEN_KEEPER_PENDING_CAP, sliceRows = SCREEN_KEEPER_SLICE_ROWS }: ScreenKeeperOptions = {},
): ScreenKeeper {
  const terminal: HeadlessTerminal = new Terminal({
    cols,
    rows,
    scrollback: SCREEN_KEEPER_SCROLLBACK,
    allowProposedApi: true,
  });
  const serializer = new SerializeAddon();
  serializer.activate(terminal);

  let mouseEncoding: MouseEncoding = null;
  const mouseEncodingHandlers = ['h', 'l'].map((final) => terminal.parser.registerCsiHandler(
    { prefix: '?', final },
    (params) => {
      mouseEncoding = updateMouseEncoding(mouseEncoding, params, final === 'h');
      return false;
    },
  ));
  mouseEncodingHandlers.push(terminal.parser.registerEscHandler({ final: 'c' }, () => {
    mouseEncoding = null;
    return false;
  }));

  let pushedOffset = 0;
  let writtenOffset = 0;
  let parsedOffset = 0;
  let queue: ResizeMarker[] = [];
  let disposed = false;
  let overrun = false;
  let heldChunks: string[] = [];
  let isHoldingWrites = false;
  let isBufferFrozen = false;
  let drainWaiters: Array<() => void> = [];
  let deepSerializeInFlight: Promise<DeepScreen | null> | null = null;

  function drainResizes(): void {
    if (disposed || isBufferFrozen) return;
    const split = pendingResizes(queue, parsedOffset);
    queue = split.rest;
    for (const marker of split.due) terminal.resize(marker.cols, marker.rows);
  }

  function settleDrainWaiters(): void {
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function writeToTerminal(chunk: string): void {
    writtenOffset += chunk.length;
    const reachedOffset = writtenOffset;
    terminal.write(chunk, () => {
      if (disposed) return;
      parsedOffset = reachedOffset;
      drainResizes();
      if (parsedOffset === writtenOffset) settleDrainWaiters();
    });
  }

  function waitForWrittenBytesToParse(): Promise<void> {
    if (disposed || parsedOffset === writtenOffset) return Promise.resolve();
    return new Promise((resolve) => { drainWaiters.push(resolve); });
  }

  function releaseHeldWrites(): void {
    isBufferFrozen = false;
    isHoldingWrites = false;
    if (disposed) return;
    drainResizes();
    const chunks = heldChunks;
    heldChunks = [];
    for (const chunk of chunks) writeToTerminal(chunk);
  }

  function serializeAttach(): string {
    return serializer.serialize({ scrollback: SCREEN_KEEPER_ATTACH_SCROLLBACK }) + serializeMouseEncoding(mouseEncoding);
  }

  async function serializeFrozenSlices(): Promise<DeepScreen | null> {
    const buffer = terminal.buffer.normal;
    const plan = planDeepSlices({
      lineCount: buffer.length,
      rows: terminal.rows,
      sliceRows,
      isWrapped: (line) => buffer.getLine(line)?.isWrapped ?? false,
    });
    const slices: string[] = [];
    for (const range of plan.ranges) {
      slices.push(serializer.serialize({ range, excludeAltBuffer: true, excludeModes: true }));
      await yieldToEventLoop();
      if (disposed) return null;
    }
    slices.push(serializer.serialize({ scrollback: plan.finalScrollback }) + serializeMouseEncoding(mouseEncoding));
    return { data: slices.join(SCREEN_KEEPER_SLICE_JOINER), parsedOffset };
  }

  async function serializeDeepHoldingWrites(): Promise<DeepScreen | null> {
    isHoldingWrites = true;
    try {
      await waitForWrittenBytesToParse();
      if (disposed) return null;
      isBufferFrozen = true;
      return await serializeFrozenSlices();
    } finally {
      releaseHeldWrites();
      deepSerializeInFlight = null;
    }
  }

  return {
    push(chunk) {
      if (disposed || overrun) return false;
      if (chunk.length === 0) return true;
      if (isKeeperOverrun(pushedOffset, parsedOffset, pendingCap)) {
        overrun = true;
        return false;
      }
      pushedOffset += chunk.length;
      if (isHoldingWrites) {
        heldChunks.push(chunk);
        return true;
      }
      writeToTerminal(chunk);
      return true;
    },
    resize(nextCols, nextRows) {
      if (disposed) return;
      queue.push({ cols: nextCols, rows: nextRows, atOffset: pushedOffset });
      drainResizes();
    },
    parsedOffset: () => parsedOffset,
    isOverrun: () => overrun,
    isDrained: () => parsedOffset === pushedOffset,
    serialize: serializeAttach,
    serializeDeep() {
      if (disposed) return Promise.resolve(null);
      if (deepSerializeInFlight) return deepSerializeInFlight;
      deepSerializeInFlight = serializeDeepHoldingWrites();
      return deepSerializeInFlight;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      queue = [];
      heldChunks = [];
      settleDrainWaiters();
      for (const handler of mouseEncodingHandlers) handler.dispose();
      serializer.dispose();
      terminal.dispose();
    },
  };
}

export { createScreenKeeper };
export type { ScreenKeeper, ScreenKeeperFactory };
