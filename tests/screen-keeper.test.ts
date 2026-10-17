import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';

import { SCREEN_RESET, SCREEN_KEEPER_SCROLLBACK, SCREEN_KEEPER_ATTACH_SCROLLBACK, SCREEN_KEEPER_SLICE_ROWS } from '../session/core/screen-keeper-core.ts';
import { createScreenKeeper } from '../session/screen-keeper.ts';
import type { ScreenKeeper } from '../session/screen-keeper.ts';
import { createSessionOutput } from '../session/session-output.ts';
import { STATES } from '../shared/states.ts';

const { Terminal } = headless;

const START_COLS = 80;
const START_ROWS = 12;
const FINAL_COLS = 46;

type Cell = [string, number, number, number, boolean, boolean, boolean];

function newTerminal(cols: number, rows: number): HeadlessTerminal {
  return new Terminal({ cols, rows, scrollback: SCREEN_KEEPER_SCROLLBACK, allowProposedApi: true });
}

function write(terminal: HeadlessTerminal, data: string): Promise<void> {
  return new Promise((resolve) => { terminal.write(data, () => resolve()); });
}

function dump(terminal: HeadlessTerminal): Cell[][] {
  const buffer = terminal.buffer.active;
  const rows: Cell[][] = [];
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    const cells: Cell[] = [];
    if (line) {
      for (let x = 0; x < terminal.cols; x += 1) {
        const cell = line.getCell(x);
        if (!cell) continue;
        cells.push([
          cell.getChars(),
          cell.getWidth(),
          cell.getFgColor(),
          cell.getBgColor(),
          cell.isBold() !== 0,
          cell.isInverse() !== 0,
          cell.isUnderline() !== 0,
        ]);
      }
    }
    rows.push(cells);
  }
  return rows;
}

const BEFORE_RESIZE = [
  '\x1b[1;31mred bold header\x1b[0m\r\n',
  '\x1b[4munderlined\x1b[24m plain \x1b[7minverse\x1b[27m\r\n',
  'wide: 世界你好 ok\r\n',
  '\x1b[?1049h',
  '\x1b[2J\x1b[H\x1b[32malt buffer screen\x1b[0m\r\n',
  '\x1b[5;20Hcursor addressed in alt\r\n',
  '\x1b[?1049l',
  'back on the normal buffer\r\n',
  ...Array.from({ length: 40 }, (_unused, index) => `scrollback line ${index} \x1b[3${index % 8}mtinted\x1b[0m\r\n`),
  '\x1b[8;10Hcursor addressed on normal\r\n',
];

const AFTER_RESIZE = [
  '\x1b[36mafter the resize\x1b[0m\r\n',
  'wide again: 日本語\r\n',
  '\x1b[2;5Hre-addressed at the new width',
];

async function keeperParsedAll(keeper: { parsedOffset(): number }, expected: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (keeper.parsedOffset() < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(keeper.parsedOffset(), expected, 'the keeper parsed every pushed byte');
}

async function buildReference(): Promise<HeadlessTerminal> {
  const terminal = newTerminal(START_COLS, START_ROWS);
  for (const chunk of BEFORE_RESIZE) await write(terminal, chunk);
  terminal.resize(FINAL_COLS, START_ROWS);
  for (const chunk of AFTER_RESIZE) await write(terminal, chunk);
  return terminal;
}

test('a snapshot replayed into a fresh terminal equals the stream it was taken from, cell for cell', async () => {
  const keeper = createScreenKeeper({ cols: START_COLS, rows: START_ROWS });
  let pushed = 0;
  for (const chunk of BEFORE_RESIZE) {
    keeper.push(chunk);
    pushed += chunk.length;
  }
  keeper.resize(FINAL_COLS, START_ROWS);
  for (const chunk of AFTER_RESIZE) {
    keeper.push(chunk);
    pushed += chunk.length;
  }
  await keeperParsedAll(keeper, pushed);

  const reference = await buildReference();
  const snapshot = SCREEN_RESET + keeper.serialize();
  const replay = newTerminal(FINAL_COLS, START_ROWS);
  await write(replay, snapshot);

  assert.deepEqual(dump(replay), dump(reference), 'the replayed screen is the live screen');
  assert.equal(replay.buffer.active.cursorX, reference.buffer.active.cursorX);
  assert.equal(replay.buffer.active.cursorY, reference.buffer.active.cursorY);

  keeper.dispose();
  reference.dispose();
  replay.dispose();
});

test('a resize is applied only once the bytes before it have parsed', async () => {
  const keeper = createScreenKeeper({ cols: START_COLS, rows: START_ROWS });
  const wideRun = `${'x'.repeat(200)}\r\n`;
  keeper.push(wideRun);
  keeper.resize(FINAL_COLS, START_ROWS);
  assert.equal(keeper.parsedOffset(), 0, 'the resize was queued behind bytes that have not parsed yet');
  await keeperParsedAll(keeper, wideRun.length);

  const reference = newTerminal(START_COLS, START_ROWS);
  await write(reference, wideRun);
  reference.resize(FINAL_COLS, START_ROWS);

  const replay = newTerminal(FINAL_COLS, START_ROWS);
  await write(replay, SCREEN_RESET + keeper.serialize());
  assert.deepEqual(dump(replay), dump(reference), 'the 200-column run wrapped at 80, not at 46');

  keeper.dispose();
  reference.dispose();
  replay.dispose();
});

test('serializing a replayed snapshot is a fixed point', async () => {
  const keeper = createScreenKeeper({ cols: START_COLS, rows: START_ROWS });
  let pushed = 0;
  for (const chunk of BEFORE_RESIZE) {
    keeper.push(chunk);
    pushed += chunk.length;
  }
  await keeperParsedAll(keeper, pushed);
  const first = keeper.serialize();

  const replay = newTerminal(START_COLS, START_ROWS);
  await write(replay, SCREEN_RESET + first);
  const second = keeper.serialize();
  assert.equal(second, first, 'the keeper is not disturbed by being serialized twice');

  keeper.dispose();
  replay.dispose();
});

test('a disposed keeper stops parsing and stops resizing', async () => {
  const keeper = createScreenKeeper({ cols: START_COLS, rows: START_ROWS });
  keeper.push('before dispose\r\n');
  await keeperParsedAll(keeper, 'before dispose\r\n'.length);
  keeper.dispose();
  keeper.push('after dispose\r\n');
  keeper.resize(20, 5);
  keeper.dispose();
  assert.equal(keeper.parsedOffset(), 'before dispose\r\n'.length);
});

const MODE_SET = 1;
const MODE_RESET = 2;

async function keeperAfter(sequence: string): Promise<ReturnType<typeof createScreenKeeper>> {
  const keeper = createScreenKeeper({ cols: START_COLS, rows: START_ROWS });
  keeper.push(sequence);
  await keeperParsedAll(keeper, sequence.length);
  return keeper;
}

async function reportedModeState(terminal: HeadlessTerminal, mode: number): Promise<number> {
  const replies: string[] = [];
  const subscription = terminal.onData((reply) => { replies.push(reply); });
  await write(terminal, `\x1b[?${mode}$p`);
  subscription.dispose();
  const match = /^\x1b\[\?(\d+);(\d+)\$y$/.exec(replies.join(''));
  assert.ok(match, 'the terminal answered DECRQM');
  assert.equal(Number(match[1]), mode);
  return Number(match[2]);
}

async function replayedTerminal(snapshot: string): Promise<HeadlessTerminal> {
  const replay = newTerminal(START_COLS, START_ROWS);
  await write(replay, SCREEN_RESET + snapshot);
  return replay;
}

for (const [tracking, trackingMode] of [[9, 'x10'], [1000, 'vt200'], [1002, 'drag'], [1003, 'any']] as const) {
  for (const encoding of [1006, 1016] as const) {
    test(`a snapshot restores mouse tracking ${tracking} with encoding ${encoding}`, async (context) => {
      const keeper = await keeperAfter(`\x1b[?${tracking};${encoding}h`);
      const snapshot = keeper.serialize();
      const replay = await replayedTerminal(snapshot);
      context.after(() => { keeper.dispose(); replay.dispose(); });

      assert.ok(snapshot.endsWith(`\x1b[?${tracking}h\x1b[?${encoding}h`));
      assert.equal(replay.modes.mouseTrackingMode, trackingMode);
      assert.equal(await reportedModeState(replay, encoding), MODE_SET);
    });
  }
}

test('split mouse mode sequences are tracked only after parsing completes', async (context) => {
  const keeper = createScreenKeeper({ cols: START_COLS, rows: START_ROWS });
  context.after(() => keeper.dispose());
  const prefix = '\x1b[?1000;10';
  keeper.push(prefix);
  await keeperParsedAll(keeper, prefix.length);
  assert.ok(!keeper.serialize().includes('\x1b[?1006h'));

  keeper.push('06h');
  await keeperParsedAll(keeper, prefix.length + 3);
  assert.ok(keeper.serialize().endsWith('\x1b[?1000h\x1b[?1006h'));
});

test('snapshot encoding follows xterm.js DECSET and DECRST semantics', async (context) => {
  const keeper = createScreenKeeper({ cols: START_COLS, rows: START_ROWS });
  context.after(() => keeper.dispose());
  let pushedOffset = 0;
  for (const [sequence, suffix] of [
    ['\x1b[?1000;1005;1006h', '\x1b[?1000h\x1b[?1006h'],
    ['\x1b[?1015l', '\x1b[?1000h\x1b[?1006h'],
    ['\x1b[?1015h', '\x1b[?1000h\x1b[?1006h'],
    ['\x1b[?1016h', '\x1b[?1000h\x1b[?1016h'],
    ['\x1b[?1006l', '\x1b[?1000h'],
  ]) {
    keeper.push(sequence);
    pushedOffset += sequence.length;
    await keeperParsedAll(keeper, pushedOffset);
    assert.ok(keeper.serialize().endsWith(suffix));
  }
});

test('a replayed snapshot stays in SGR after a combined DECSET ending in the unsupported 1015', async (context) => {
  const keeper = await keeperAfter('\x1b[?1000;1006;1015h');
  const replay = await replayedTerminal(keeper.serialize());
  context.after(() => { keeper.dispose(); replay.dispose(); });

  assert.equal(await reportedModeState(replay, 1006), MODE_SET);
});

test('a replayed snapshot stays in SGR after DECRST of the unsupported 1015', async (context) => {
  const keeper = await keeperAfter('\x1b[?1000;1006h\x1b[?1015l');
  const replay = await replayedTerminal(keeper.serialize());
  context.after(() => { keeper.dispose(); replay.dispose(); });

  assert.equal(await reportedModeState(replay, 1006), MODE_SET);
});

test('a replayed snapshot keeps SGR encoding when tracking was off at reconnect and is reenabled later', async (context) => {
  const keeper = await keeperAfter('\x1b[?1000;1006h\x1b[?1000l');
  const snapshot = keeper.serialize();
  const replay = await replayedTerminal(snapshot);
  context.after(() => { keeper.dispose(); replay.dispose(); });

  assert.ok(snapshot.endsWith('\x1b[?1006h'));
  assert.equal(replay.modes.mouseTrackingMode, 'none');
  await write(replay, '\x1b[?1000h');
  assert.equal(replay.modes.mouseTrackingMode, 'vt200');
  assert.equal(await reportedModeState(replay, 1006), MODE_SET);
});

test('a replayed snapshot is in default encoding after DECRST 1006', async (context) => {
  const keeper = await keeperAfter('\x1b[?1000;1006h\x1b[?1006l');
  const replay = await replayedTerminal(keeper.serialize());
  context.after(() => { keeper.dispose(); replay.dispose(); });

  assert.equal(await reportedModeState(replay, 1006), MODE_RESET);
});

test('ordinary CSI modes and title text do not change mouse encoding', async (context) => {
  const keeper = createScreenKeeper({ cols: START_COLS, rows: START_ROWS });
  context.after(() => keeper.dispose());
  const sequence = '\x1b[?1000;1006h\x1b[1016h\x1b]0;[?1016h\x07';
  keeper.push(sequence);
  await keeperParsedAll(keeper, sequence.length);
  assert.ok(keeper.serialize().endsWith('\x1b[?1000h\x1b[?1006h'));
});

test('a full terminal reset clears mouse encoding and subsequent DECSET is still tracked', async (context) => {
  const keeper = createScreenKeeper({ cols: START_COLS, rows: START_ROWS });
  context.after(() => keeper.dispose());
  const sequence = '\x1b[?1000;1006h\x1bc\x1b[?1000h';
  keeper.push(sequence);
  await keeperParsedAll(keeper, sequence.length);
  assert.ok(keeper.serialize().endsWith('\x1b[?1000h'));
  assert.ok(!keeper.serialize().includes('\x1b[?1006h'));

  const enableEncoding = '\x1b[?1006h';
  keeper.push(enableEncoding);
  await keeperParsedAll(keeper, sequence.length + enableEncoding.length);
  assert.ok(keeper.serialize().endsWith('\x1b[?1000h\x1b[?1006h'));
});

function deepHistoryChunks(lineCount: number): string[] {
  return Array.from({ length: lineCount }, (_unused, index) => {
    const tint = `\x1b[3${index % 8}m`;
    if (index % 5 === 0) return `${tint}wrapped history ${index} ${'w'.repeat(170)}\r\n`;
    if (index % 7 === 0) return `${tint}open colour ${index} carried\r\n`;
    return `history line ${index} ${tint}tinted\x1b[0m\r\n`;
  });
}

async function keeperAfterChunks(chunks: string[], sliceRows?: number): Promise<ScreenKeeper> {
  const keeper = createScreenKeeper({ cols: START_COLS, rows: START_ROWS }, sliceRows === undefined ? {} : { sliceRows });
  let pushed = 0;
  for (const chunk of chunks) {
    keeper.push(chunk);
    pushed += chunk.length;
  }
  await keeperParsedAll(keeper, pushed);
  return keeper;
}

async function referenceAfterChunks(chunks: string[]): Promise<HeadlessTerminal> {
  const reference = newTerminal(START_COLS, START_ROWS);
  await write(reference, chunks.join(''));
  return reference;
}

test('a deep snapshot serialized in slices replays cell for cell, across wrapped rows and open colours at every boundary', async (context) => {
  const chunks = [...deepHistoryChunks(400), '\x1b[3;7Hcursor parked mid screen'];
  const keeper = await keeperAfterChunks(chunks, 7);
  const reference = await referenceAfterChunks(chunks);
  const deepScreen = await keeper.serializeDeep();
  assert.ok(deepScreen);
  const replay = await replayedTerminal(deepScreen.data);
  context.after(() => { keeper.dispose(); reference.dispose(); replay.dispose(); });

  assert.deepEqual(dump(replay), dump(reference));
  assert.equal(replay.buffer.active.cursorX, reference.buffer.active.cursorX);
  assert.equal(replay.buffer.active.cursorY, reference.buffer.active.cursorY);
});

test('the keeper holds 5000 lines for a deep snapshot while the attach snapshot carries 500', async (context) => {
  const chunks = deepHistoryChunks(6000);
  const keeper = await keeperAfterChunks(chunks);
  const reference = await referenceAfterChunks(chunks);
  const deepScreen = await keeper.serializeDeep();
  assert.ok(deepScreen);
  const deepReplay = await replayedTerminal(deepScreen.data);
  const attachReplay = await replayedTerminal(keeper.serialize());
  context.after(() => { keeper.dispose(); reference.dispose(); deepReplay.dispose(); attachReplay.dispose(); });

  assert.equal(reference.buffer.active.length, SCREEN_KEEPER_SCROLLBACK + START_ROWS);
  assert.deepEqual(dump(deepReplay), dump(reference));
  assert.equal(attachReplay.buffer.active.length, SCREEN_KEEPER_ATTACH_SCROLLBACK + START_ROWS);
});

test('a deep serialize gives the event loop a turn between every slice', async (context) => {
  const keeper = await keeperAfterChunks(deepHistoryChunks(6000));
  context.after(() => keeper.dispose());
  const sliceDurationsMs: number[] = [];
  let sliceStartedAt = performance.now();
  let isSerializing = true;
  const onEachTurn = (): void => {
    if (!isSerializing) return;
    const now = performance.now();
    sliceDurationsMs.push(now - sliceStartedAt);
    sliceStartedAt = now;
    setImmediate(onEachTurn);
  };
  setImmediate(onEachTurn);
  await keeper.serializeDeep();
  isSerializing = false;

  const longestTurnMs = Math.max(...sliceDurationsMs);
  context.diagnostic(`longest event loop turn during a 5000-line deep serialize: ${longestTurnMs.toFixed(1)} ms`);
  const sliceCount = Math.ceil(SCREEN_KEEPER_SCROLLBACK / SCREEN_KEEPER_SLICE_ROWS);
  assert.ok(sliceDurationsMs.length >= sliceCount - 1, `the event loop turned ${sliceDurationsMs.length} times across ${sliceCount} slices`);
});

test('output pushed during a sliced serialize is held so the deep snapshot matches one offset', async (context) => {
  const noop = () => {};
  const output = createSessionOutput({
    maxBytes: 4 * 1024 * 1024,
    getState: () => STATES.RUNNING,
    isDestroyed: () => false,
    hasLivePty: () => true,
    write: noop,
    start: noop,
    restart: noop,
    on: noop,
    once: noop,
    off: noop,
    screenKeeperFactory: (size) => createScreenKeeper(size, { sliceRows: 50 }),
  });
  context.after(() => output.disposeScreenKeeper());
  output.rememberSize(START_COLS, START_ROWS);
  const history = deepHistoryChunks(600);
  for (const chunk of history) output.push(chunk);

  const pending = output.deepSnapshot();
  const duringSerialize = ['\x1b[35marrived mid serialize\x1b[0m\r\n', 'and another\r\n'];
  for (const chunk of duringSerialize) {
    await new Promise((resolve) => setImmediate(resolve));
    output.push(chunk);
  }
  const deep = await pending;
  const afterSerialize = 'after the snapshot\r\n';
  output.push(afterSerialize);

  assert.equal(output.since(deep.offset).data, afterSerialize, 'the snapshot offset covers every byte it carries');
  const reference = await referenceAfterChunks([...history, ...duringSerialize]);
  const replay = newTerminal(START_COLS, START_ROWS);
  context.after(() => { reference.dispose(); replay.dispose(); });
  await write(replay, deep.data);
  assert.deepEqual(dump(replay), dump(reference));
});

test('a keeper that falls further behind than its pending cap is replaced instead of throwing', async () => {
  const keepers: ScreenKeeper[] = [];
  const noop = () => {};
  const output = createSessionOutput({
    maxBytes: 64 * 1024,
    getState: () => STATES.RUNNING,
    isDestroyed: () => false,
    hasLivePty: () => true,
    write: noop,
    start: noop,
    restart: noop,
    on: noop,
    once: noop,
    off: noop,
    screenKeeperFactory: (size) => {
      const keeper = createScreenKeeper(size, { pendingCap: 1024 });
      keepers.push(keeper);
      return keeper;
    },
  });
  output.rememberSize(START_COLS, START_ROWS);
  const flood = `${'f'.repeat(600)}\r\n`;
  output.push(flood);
  output.push(flood);
  output.push(flood);
  assert.equal(keepers.length, 1);
  assert.ok(keepers[0].isOverrun(), 'the third flood found 1.2 KB unparsed behind a 1 KB cap');
  assert.equal(output.snapshot().data, SCREEN_RESET + flood + flood + flood, 'a saturated keeper yields to the ring');
  await keeperParsedAll(keepers[0], flood.length * 2);

  const afterFlood = 'after the flood\r\n';
  output.push(afterFlood);
  assert.equal(keepers.length, 2, 'the drained keeper was replaced');
  assert.ok(!keepers[1].isOverrun());
  await keeperParsedAll(keepers[1], flood.length * 3 + afterFlood.length);

  const snapshot = output.snapshot();
  assert.equal(snapshot.offset, output.stats().total);
  const reference = newTerminal(START_COLS, START_ROWS);
  await write(reference, flood + flood + flood + afterFlood);
  const replay = newTerminal(START_COLS, START_ROWS);
  await write(replay, snapshot.data);
  assert.deepEqual(dump(replay), dump(reference), 'the replacement keeper was seeded from the ring');
  output.disposeScreenKeeper();
  reference.dispose();
  replay.dispose();
});
