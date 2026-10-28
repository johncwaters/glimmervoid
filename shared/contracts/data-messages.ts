import { z } from 'zod';

export const VIEWER_MIN_COLS = 1;
export const VIEWER_MAX_COLS = 500;
export const VIEWER_MIN_ROWS = 1;
export const VIEWER_MAX_ROWS = 200;

const viewerCols = z.number().int().min(VIEWER_MIN_COLS).max(VIEWER_MAX_COLS);
const viewerRows = z.number().int().min(VIEWER_MIN_ROWS).max(VIEWER_MAX_ROWS);

export const DataClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string() }),
  z.object({ type: z.literal('claim'), cols: viewerCols, rows: viewerRows }),
  z.object({ type: z.literal('unview') }),
  z.object({ type: z.literal('pause-output') }),
  z.object({ type: z.literal('resume-output') }),
]);
export type DataClientMessage = z.infer<typeof DataClientMessage>;

export const PtySizeFrame = z.object({
  type: z.literal('pty-size'),
  cols: viewerCols,
  rows: viewerRows,
  seq: z.number().int().nonnegative(),
});
export type PtySizeFrame = z.infer<typeof PtySizeFrame>;

export const OUTPUT_BEAT_INTERVAL_MS = 320;

export const OutputBeatFrame = z.object({ type: z.literal('output-beat') });
export type OutputBeatFrame = z.infer<typeof OutputBeatFrame>;

const DataServerFrame = z.discriminatedUnion('type', [PtySizeFrame, OutputBeatFrame]);
type DataServerFrame = z.infer<typeof DataServerFrame>;

export const DATA_ATTACH_HISTORY_PARAM = 'history';
export const DATA_ATTACH_OUTPUT_PARAM = 'output';
export const DATA_ATTACH_PAUSED_OUTPUT = 'paused';

export const DEEP_HISTORY_SCROLLBACK_LINES = 5000;

const DataAttachHistory = z.enum(['screen', 'deep']);
type DataAttachHistory = z.infer<typeof DataAttachHistory>;

function decodeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseDataClientMessage(raw: string): DataClientMessage | null {
  const parsed = DataClientMessage.safeParse(decodeJson(raw));
  if (!parsed.success) return null;
  return parsed.data;
}

export function parseDataServerFrame(raw: string): DataServerFrame | null {
  const parsed = DataServerFrame.safeParse(decodeJson(raw));
  if (!parsed.success) return null;
  return parsed.data;
}

export const FAST_TERMINAL_CLOSE_MS = 1000;
export const LOGGED_FAST_CLOSE_COUNTS: ReadonlySet<number> = new Set([1, 5, 25, 100]);

interface DataAttachRequest {
  history: DataAttachHistory;
  isOutputPaused: boolean;
}

function attachQueryOf(rawUrl: unknown): URLSearchParams {
  if (typeof rawUrl !== 'string') return new URLSearchParams();
  const queryAt = rawUrl.indexOf('?');
  if (queryAt === -1) return new URLSearchParams();
  return new URLSearchParams(rawUrl.slice(queryAt + 1).split('#')[0]);
}

export function parseDataAttach(rawUrl: unknown): DataAttachRequest {
  const query = attachQueryOf(rawUrl);
  const history = DataAttachHistory.safeParse(query.get(DATA_ATTACH_HISTORY_PARAM));
  return {
    history: history.success ? history.data : 'screen',
    isOutputPaused: query.get(DATA_ATTACH_OUTPUT_PARAM) === DATA_ATTACH_PAUSED_OUTPUT,
  };
}

export function describeDataAttach(attach: DataAttachRequest): string {
  return attach.isOutputPaused ? `${attach.history} paused` : attach.history;
}
