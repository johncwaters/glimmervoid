type SpillWrappingAgent = 'claude-code' | 'kimi' | 'pi' | 'antigravity';
type UnwrappedToolOutput = { output: string; isSpilled: boolean };

const CLAUDE_PERSISTED_OUTPUT = /^<persisted-output>\n[^\n]*\n\nPreview \([^)\n]*\):\n([\s\S]*?)(?:\n\.\.\.)?\n<\/persisted-output>$/;
const KIMI_SAVED_OUTPUT_HEADER = /^Tool output exceeded \d+ characters[^\n]*\n(?:[a-z_]+: [^\n]*\n)*\n\[preview: chars \[0, \d+\)\]\n/;
const PI_FULL_OUTPUT_NOTE_STARTS = ['\n\n[Showing ', '\n\n[Output truncated. '];
const PI_FULL_OUTPUT_PATH_MARKER = '. Full output: ';
const PI_STATUS_AFTER_NOTE = /^(?:\n\n(?:Command exited with code -?\d+|Command timed out after \d+ seconds|Command aborted))?$/;
const PI_STATUS_MAX_CHARS = 64;
const KIMI_APPENDED_POINTER_START = '\n[Per-line truncation occurred;';
const ANTIGRAVITY_TRUNCATED_HEADER = /^The tool's output was truncated due to being too long\.[^\n]*\n\nHere is a preview with the middle of the output truncated:\n/;

function withoutMatch(output: string, pattern: RegExp): string | null {
  const match = pattern.exec(output);
  if (!match) return null;
  return output.slice(0, match.index) + output.slice(match.index + match[0].length);
}

function withoutPiFullOutputNote(output: string): string | null {
  const noteStart = Math.max(...PI_FULL_OUTPUT_NOTE_STARTS.map((start) => output.lastIndexOf(start)));
  if (noteStart < 0) return null;
  const noteEnd = output.indexOf(']', noteStart);
  if (noteEnd < 0) return null;
  const note = output.slice(noteStart + 2, noteEnd);
  if (note.includes('\n') || !note.includes(PI_FULL_OUTPUT_PATH_MARKER)) return null;
  const statusAfterNote = output.slice(noteEnd + 1);
  if (statusAfterNote.length > PI_STATUS_MAX_CHARS || !PI_STATUS_AFTER_NOTE.test(statusAfterNote)) return null;
  return output.slice(0, noteStart) + statusAfterNote;
}

function withoutKimiSpill(output: string): string | null {
  const withoutHeader = withoutMatch(output, KIMI_SAVED_OUTPUT_HEADER);
  if (withoutHeader !== null) return withoutHeader;
  const pointerStart = output.lastIndexOf(KIMI_APPENDED_POINTER_START);
  if (pointerStart < 0 || !output.endsWith(']')) return null;
  return output.slice(0, pointerStart);
}

const UNWRAP_BY_AGENT: Record<SpillWrappingAgent, (output: string) => string | null> = {
  'claude-code': (output) => CLAUDE_PERSISTED_OUTPUT.exec(output)?.[1] ?? null,
  kimi: withoutKimiSpill,
  pi: withoutPiFullOutputNote,
  antigravity: (output) => withoutMatch(output, ANTIGRAVITY_TRUNCATED_HEADER),
};

function unwrapSpilledToolOutput(agent: SpillWrappingAgent, output: string): UnwrappedToolOutput {
  const unwrapped = UNWRAP_BY_AGENT[agent](output);
  if (unwrapped === null) return { output, isSpilled: false };
  return { output: unwrapped, isSpilled: true };
}

export { unwrapSpilledToolOutput };
export type { SpillWrappingAgent };
