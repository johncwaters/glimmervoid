import { WHITEBOARD_LIMITS } from './contracts/whiteboard.ts';
import { isRecord } from './coerce.ts';
import { BOX_SHAPES, BYLINE_PREFIX } from './whiteboard-shapes.ts';

function lineWithoutRetiredFields(line: unknown): unknown {
  if (!isRecord(line)) return line;
  const { icon: _icon, ref: _ref, ...keptLine } = line;
  return keptLine.style === 'numbered' ? { ...keptLine, style: 'item' } : keptLine;
}

function stepWithoutLink(step: unknown): unknown {
  if (!isRecord(step)) return step;
  const { linkedBoardId: _linkedBoardId, ...keptStep } = step;
  return keptStep;
}

function boxWithoutRetiredFields(box: Record<string, unknown>): Record<string, unknown> {
  const { outputs: _outputs, ...keptBox } = box;
  const lines = Array.isArray(box.lines) ? { lines: box.lines.map(lineWithoutRetiredFields) } : {};
  const step = 'step' in box ? { step: stepWithoutLink(box.step) } : {};
  return { ...keptBox, ...lines, ...step };
}

function withPlace(box: Record<string, unknown>): Record<string, unknown> {
  if ('place' in box) return box;
  const { at, ...boxWithoutAt } = box;
  if (isRecord(at)) return { ...boxWithoutAt, place: { at } };
  return { ...boxWithoutAt, place: isRecord(box.step) ? 'plan' : 'aside' };
}

function withAuthorFromByline(note: Record<string, unknown>): Record<string, unknown> {
  if ('author' in note || !Array.isArray(note.lines)) return note;
  const lastLine: unknown = note.lines.at(-1);
  if (!isRecord(lastLine) || lastLine.muted !== true || typeof lastLine.text !== 'string' || !lastLine.text.startsWith(BYLINE_PREFIX)) return note;
  return { ...note, author: lastLine.text.slice(BYLINE_PREFIX.length).slice(0, WHITEBOARD_LIMITS.title) || null, lines: note.lines.slice(0, -1) };
}

function withFiveShapes(box: Record<string, unknown>): Record<string, unknown> {
  if (box.shape === 'panel') return { ...box, shape: 'box' };
  if (box.shape === 'text') return { ...box, shape: 'box', borderless: true };
  if (box.shape === 'sticky') return { ...box, shape: 'note', tone: box.tone ?? 'yellow' };
  return box.shape === 'note' ? withAuthorFromByline(box) : box;
}

function isCurrentStoredBox(box: Record<string, unknown>): boolean {
  return 'place' in box && (box.shape === undefined || BOX_SHAPES.some((shape) => shape === box.shape));
}

function currentStoredBox(box: Record<string, unknown>): Record<string, unknown> {
  return withPlace(withFiveShapes(boxWithoutRetiredFields(box)));
}

export { currentStoredBox, isCurrentStoredBox };
