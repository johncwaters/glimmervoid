import { createRequire } from "node:module";
import headless from "@xterm/headless";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import { serializeMouseEncoding, updateMouseEncoding } from "./core/mouse-encoding-core.ts";
import type { MouseEncoding } from "./core/mouse-encoding-core.ts";
import { SCREEN_KEEPER_PENDING_CAP, SCREEN_KEEPER_SCROLLBACK, isKeeperOverrun, pendingResizes } from "./core/screen-keeper-core.ts";
import type { ResizeMarker } from "./core/screen-keeper-core.ts";

const { Terminal } = headless;

interface SerializerPort {
  activate(terminal: unknown): void;
  serialize(options?: { scrollback?: number }): string;
  dispose(): void;
}

interface SerializeAddonModule {
  SerializeAddon: new () => SerializerPort;
}

const { SerializeAddon } = createRequire(import.meta.url)("@xterm/addon-serialize") as SerializeAddonModule;

interface ScreenKeeper {
  push(chunk: string): boolean;
  resize(cols: number, rows: number): void;
  parsedOffset(): number;
  isOverrun(): boolean;
  isDrained(): boolean;
  serialize(): string;
  dispose(): void;
}

interface ScreenKeeperOptions {
  pendingCap?: number;
}

type ScreenKeeperFactory = (size: { cols: number; rows: number }) => ScreenKeeper;

function createScreenKeeper(
  { cols, rows }: { cols: number; rows: number },
  { pendingCap = SCREEN_KEEPER_PENDING_CAP }: ScreenKeeperOptions = {},
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
  let parsedOffset = 0;
  let queue: ResizeMarker[] = [];
  let disposed = false;
  let overrun = false;

  function drainResizes(): void {
    if (disposed) return;
    const split = pendingResizes(queue, parsedOffset);
    queue = split.rest;
    for (const marker of split.due) terminal.resize(marker.cols, marker.rows);
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
      const reachedOffset = pushedOffset;
      terminal.write(chunk, () => {
        if (disposed) return;
        parsedOffset = reachedOffset;
        drainResizes();
      });
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
    serialize: () => serializer.serialize({ scrollback: SCREEN_KEEPER_SCROLLBACK })
      + serializeMouseEncoding(mouseEncoding),
    dispose() {
      if (disposed) return;
      disposed = true;
      queue = [];
      for (const handler of mouseEncodingHandlers) handler.dispose();
      serializer.dispose();
      terminal.dispose();
    },
  };
}

export { createScreenKeeper };
export type { ScreenKeeper, ScreenKeeperFactory };
