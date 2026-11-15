const ESC = '\x1b';
const DEL = '\x7f';
const BACKSPACE = '\x08';
const CTRL_U = '\x15';
const OUT_OF_BAND_PREFIX = `${ESC}]7777;`;
const BEL = '\x07';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

const AGENT_COMMANDS = ['mouse-on', 'mouse-off', 'focus-on', 'focus-off', 'da', 'fullscreen', 'leave-fullscreen', 'work', 'stop'] as const;
type AgentCommand = (typeof AGENT_COMMANDS)[number];

const THUMBS_UP_MEDIUM_SKIN = String.fromCodePoint(0x1f44d, 0x1f3fd);
const TYPED_WORDS = ['hello', 'wor', 'teh', 'the', 'I', 'dont', 'café', 'naïve', 'ok', THUMBS_UP_MEDIUM_SKIN];
const AUTOCORRECT_WORDS = ['world', 'the', "don't", 'Hello', 'cafe'];
const PASTED_TEXTS = ['pasted', 'two words'];

type SearchAction =
  | { kind: 'type'; text: string }
  | { kind: 'compose'; word: string }
  | { kind: 'autocorrect'; replacement: string }
  | { kind: 'keyboard-delete' }
  | { kind: 'press'; key: 'Backspace' | 'Enter' }
  | { kind: 'tap-terminal'; xFraction: number; yFraction: number }
  | { kind: 'scroll'; lines: number }
  | { kind: 'strip-key'; position: number }
  | { kind: 'paste'; text: string }
  | { kind: 'keyboard-close' }
  | { kind: 'keyboard-open' }
  | { kind: 'agent'; command: AgentCommand };

interface FieldWrite {
  value: string;
  isByOurCode: boolean;
}

interface StepObservation {
  action: SearchAction;
  sentBytes: string;
  fieldBefore: string;
  fieldAfter: string;
  fieldWrites: FieldWrite[];
}

interface LineState {
  graphemes: string[];
  caret: number;
  isKnown: boolean;
  hasUnknownPrefix: boolean;
}

interface OracleFailure {
  oracle: 'mirror' | 'field';
  message: string;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function graphemesOf(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (grapheme) => grapheme.segment);
}

const EMPTY_LINE: LineState = { graphemes: [], caret: 0, isKnown: true, hasUnknownPrefix: false };

function pick<Item>(random: () => number, items: readonly Item[]): Item {
  return items[Math.floor(random() * items.length)] as Item;
}

const ACTION_MAKERS: { weight: number; make: (random: () => number) => SearchAction }[] = [
  { weight: 20, make: (random) => ({ kind: 'type', text: pick(random, TYPED_WORDS) + (random() < 0.6 ? ' ' : '') }) },
  { weight: 8, make: (random) => ({ kind: 'compose', word: pick(random, TYPED_WORDS) }) },
  { weight: 6, make: (random) => ({ kind: 'autocorrect', replacement: pick(random, AUTOCORRECT_WORDS) }) },
  { weight: 6, make: () => ({ kind: 'keyboard-delete' }) },
  { weight: 8, make: () => ({ kind: 'press', key: 'Backspace' }) },
  { weight: 3, make: () => ({ kind: 'press', key: 'Enter' }) },
  { weight: 6, make: (random) => ({ kind: 'tap-terminal', xFraction: 0.1 + random() * 0.8, yFraction: 0.1 + random() * 0.8 }) },
  { weight: 3, make: (random) => ({ kind: 'scroll', lines: (random() < 0.5 ? -1 : 1) * (1 + Math.floor(random() * 4)) }) },
  { weight: 4, make: (random) => ({ kind: 'strip-key', position: Math.floor(random() * 8) }) },
  { weight: 2, make: (random) => ({ kind: 'paste', text: pick(random, PASTED_TEXTS) }) },
  { weight: 2, make: () => ({ kind: 'keyboard-close' }) },
  { weight: 3, make: () => ({ kind: 'keyboard-open' }) },
  { weight: 5, make: (random) => ({ kind: 'agent', command: pick(random, AGENT_COMMANDS) }) },
];

const TOTAL_ACTION_WEIGHT = ACTION_MAKERS.reduce((total, maker) => total + maker.weight, 0);

function generateAction(random: () => number): SearchAction {
  let remainingWeight = random() * TOTAL_ACTION_WEIGHT;
  for (const maker of ACTION_MAKERS) {
    remainingWeight -= maker.weight;
    if (remainingWeight < 0) return maker.make(random);
  }
  return ACTION_MAKERS[0]?.make(random) ?? { kind: 'keyboard-open' };
}

function insertText(line: LineState, text: string): LineState {
  const inserted = graphemesOf(text);
  const graphemes = [...line.graphemes.slice(0, line.caret), ...inserted, ...line.graphemes.slice(line.caret)];
  return { ...line, graphemes, caret: line.caret + inserted.length };
}

function deleteBackward(line: LineState, count: number): LineState {
  if (count > line.caret && line.hasUnknownPrefix) return { ...line, isKnown: false };
  const removed = Math.min(count, line.caret);
  const graphemes = [...line.graphemes.slice(0, line.caret - removed), ...line.graphemes.slice(line.caret)];
  return { ...line, graphemes, caret: line.caret - removed };
}

function wordLengthBeforeCaret(line: LineState): number {
  let index = line.caret;
  while (index > 0 && line.graphemes[index - 1] === ' ') index -= 1;
  while (index > 0 && line.graphemes[index - 1] !== ' ') index -= 1;
  const mayContinueIntoUnknownPrefix = index === 0 && line.hasUnknownPrefix;
  return line.caret - index + (mayContinueIntoUnknownPrefix ? 1 : 0);
}

const KNOWN_TAIL_AFTER_UNKNOWN_EDIT: LineState = { graphemes: [], caret: 0, isKnown: true, hasUnknownPrefix: true };

function moveCaret(line: LineState, delta: number): LineState {
  const isLeavingKnownTail = line.caret + delta < 0 || line.caret + delta > line.graphemes.length;
  if (isLeavingKnownTail && line.hasUnknownPrefix) return { ...line, isKnown: false };
  return { ...line, caret: Math.max(0, Math.min(line.graphemes.length, line.caret + delta)) };
}

function escapeSequenceLength(bytes: string, start: number): number {
  const introducer = bytes[start + 1];
  if (introducer === '[') {
    let index = start + 2;
    while (index < bytes.length && !/[\x40-\x7e]/.test(bytes[index] ?? '')) index += 1;
    return index - start + 1;
  }
  if (introducer === ']') {
    const end = bytes.indexOf(BEL, start);
    return end === -1 ? bytes.length - start : end - start + 1;
  }
  if (introducer === 'O') return 3;
  if (introducer === DEL) return 2;
  return 1;
}

function applyEscapeSequence(line: LineState, sequence: string): LineState {
  if (sequence === `${ESC}${DEL}`) return deleteBackward(line, wordLengthBeforeCaret(line));
  if (sequence.startsWith(`${ESC}]`)) return line;
  if (/^\x1b\[<[\d;]+[Mm]$/.test(sequence)) return line;
  if (sequence === `${ESC}[I` || sequence === `${ESC}[O`) return line;
  if (/^\x1b\[\?[\d;]*c$/.test(sequence)) return line;
  if (sequence === `${ESC}[C` || sequence === `${ESC}OC`) return moveCaret(line, 1);
  if (sequence === `${ESC}[D` || sequence === `${ESC}OD`) return moveCaret(line, -1);
  return KNOWN_TAIL_AFTER_UNKNOWN_EDIT;
}

function rebuildLine(previous: LineState, sentBytes: string): LineState {
  let line = previous;
  let index = 0;
  while (index < sentBytes.length) {
    if (sentBytes.startsWith(PASTE_START, index)) {
      const end = sentBytes.indexOf(PASTE_END, index);
      const pastedEnd = end === -1 ? sentBytes.length : end;
      line = insertText(line, sentBytes.slice(index + PASTE_START.length, pastedEnd));
      index = end === -1 ? sentBytes.length : end + PASTE_END.length;
      continue;
    }
    const character = sentBytes[index] ?? '';
    if (character === ESC) {
      const length = escapeSequenceLength(sentBytes, index);
      line = applyEscapeSequence(line, sentBytes.slice(index, index + length));
      index += length;
      continue;
    }
    index += 1;
    if (character === '\r' || character === '\n') {
      line = EMPTY_LINE;
      continue;
    }
    if (character === DEL || character === BACKSPACE) {
      line = deleteBackward(line, 1);
      continue;
    }
    if (character === CTRL_U) {
      line = { ...line, graphemes: line.graphemes.slice(line.caret), caret: 0, hasUnknownPrefix: false };
      continue;
    }
    if (character < ' ') {
      line = KNOWN_TAIL_AFTER_UNKNOWN_EDIT;
      continue;
    }
    const codePoint = sentBytes.codePointAt(index - 1) ?? 0;
    const fullCharacter = String.fromCodePoint(codePoint);
    index += fullCharacter.length - 1;
    line = appendCodePoint(line, fullCharacter);
  }
  return line;
}

function appendCodePoint(line: LineState, character: string): LineState {
  if (line.caret === 0) return insertText(line, character);
  const before = line.graphemes[line.caret - 1] ?? '';
  const joined = graphemesOf(before + character);
  if (joined.length !== 1) return insertText(line, character);
  const graphemes = [...line.graphemes];
  graphemes[line.caret - 1] = joined[0] ?? '';
  return { ...line, graphemes };
}

function stripReplies(sentBytes: string): string {
  return sentBytes
    .replace(/\x1b\[<[\d;]+[Mm]/g, '')
    .replace(/\x1b\[[IO]/g, '')
    .replace(/\x1b\[\?[\d;]*c/g, '')
    .replace(/\x1b\]7777;[^\x07]*\x07/g, '');
}

const LINE_CHANGING_BYTES = /\x1b(?!\x7f)(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|O.)?|[\x00-\x1a\x1c-\x1f]/g;

function textTypedAfterLastLineChange(sentBytes: string): string | null {
  const keyboardBytes = stripReplies(sentBytes);
  let tailStart = -1;
  for (const match of keyboardBytes.matchAll(LINE_CHANGING_BYTES)) tailStart = match.index + match[0].length;
  if (tailStart === -1) return null;
  return rebuildLine(EMPTY_LINE, keyboardBytes.slice(tailStart)).graphemes.join('');
}

function checkStep(line: LineState, step: StepObservation): OracleFailure | null {
  const typedSinceLineChange = textTypedAfterLastLineChange(step.sentBytes);
  const isLineChangedOutsideKeyboard = typedSinceLineChange !== null;
  const wasEmptiedByOurCode = step.fieldWrites.some((write, index) => {
    if (!write.isByOurCode || write.value !== '') return false;
    const valueBefore = index === 0 ? step.fieldBefore : step.fieldWrites[index - 1]?.value ?? '';
    return valueBefore !== '';
  });
  const isAllowedToEmptyField = step.action.kind === 'keyboard-close' || step.action.kind === 'paste';
  if (wasEmptiedByOurCode && !isLineChangedOutsideKeyboard && !isAllowedToEmptyField) {
    return { oracle: 'field', message: `the keyboard field was emptied by our code in a step that sent only ${JSON.stringify(step.sentBytes)}, so the keyboard would start a new sentence` };
  }
  if (isLineChangedOutsideKeyboard && step.fieldAfter !== typedSinceLineChange) {
    return { oracle: 'field', message: `the line changed outside the keyboard (sent ${JSON.stringify(step.sentBytes)}) but the keyboard field holds ${JSON.stringify(step.fieldAfter)} instead of ${JSON.stringify(typedSinceLineChange)}, the text typed since` };
  }
  if (!line.isKnown || step.fieldAfter === '') return null;
  const textBeforeCaret = line.graphemes.slice(0, line.caret).join('');
  if (textBeforeCaret.endsWith(step.fieldAfter)) return null;
  return { oracle: 'mirror', message: `the agent's line is ${JSON.stringify(line.graphemes.join(''))} (caret ${line.caret}) but the keyboard field holds ${JSON.stringify(step.fieldAfter)}, which is not the text before the caret` };
}

async function shrinkActions(
  actions: SearchAction[],
  firstFailingStep: number,
  stillFails: (candidate: SearchAction[]) => Promise<boolean>,
  hasTimeLeft: () => boolean,
): Promise<SearchAction[]> {
  let shortest = actions.slice(0, firstFailingStep + 1);
  for (let chunkSize = Math.floor(shortest.length / 2); chunkSize >= 1; chunkSize = Math.floor(chunkSize / 2)) {
    for (let start = shortest.length - 1 - chunkSize; start >= 0; start -= chunkSize) {
      if (!hasTimeLeft()) return shortest;
      const candidate = [...shortest.slice(0, start), ...shortest.slice(start + chunkSize)];
      if (await stillFails(candidate)) shortest = candidate;
    }
  }
  return shortest;
}

function describeAction(action: SearchAction): string {
  const { kind, ...details } = action;
  const detailText = Object.values(details).map((value) => JSON.stringify(value)).join(' ');
  return detailText === '' ? kind : `${kind} ${detailText}`;
}

export { AGENT_COMMANDS, EMPTY_LINE, OUT_OF_BAND_PREFIX, checkStep, describeAction, generateAction, graphemesOf, rebuildLine, shrinkActions };
export type { AgentCommand, FieldWrite, LineState, OracleFailure, SearchAction, StepObservation };
