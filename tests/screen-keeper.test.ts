import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';

import { SCREEN_RESET, SCREEN_KEEPER_SCROLLBACK } from '../session/core/screen-keeper-core.ts';
import { createScreenKeeper } from '../session/screen-keeper.ts';

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
