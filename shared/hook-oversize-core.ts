import { CONVERSATION_TOOL_RESULT_HOOK_EVENT } from './contracts/session.ts';

const HOOK_BODY_CAP_BYTES = 64 * 1024;
const SILENT_OVERSIZE_HOOK_EVENTS: ReadonlySet<string> = new Set([
  'posttooluse',
  'posttoolusefailure',
  CONVERSATION_TOOL_RESULT_HOOK_EVENT,
]);

const QUOTE_BYTE = 0x22;
const BACKSLASH_BYTE = 0x5c;
const OPEN_BRACE_BYTE = 0x7b;
const CLOSE_BRACE_BYTE = 0x7d;
const OPEN_BRACKET_BYTE = 0x5b;
const CLOSE_BRACKET_BYTE = 0x5d;
const COLON_BYTE = 0x3a;
const COMMA_BYTE = 0x2c;
const TARGET_KEY = 'agent_id';

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

type ScannerMode = 'scan' | 'in-string' | 'in-string-escape' | 'awaiting-colon' | 'awaiting-value' | 'found';

interface TopLevelAgentIdScanner {
  push(chunk: Buffer): void;
  hasTopLevelAgentId(): boolean;
}

function createTopLevelAgentIdScanner(): TopLevelAgentIdScanner {
  let depth = 0;
  let mode: ScannerMode = 'scan';
  let expectsKeyAtDepthOne = 0;
  let keyMatchPos = -1;

  function push(chunk: Buffer): void {
    if (mode === 'found') return;
    for (let i = 0; i < chunk.length; i += 1) {
      const byte = chunk[i];
      if (byte === undefined) continue;
      if (mode === 'in-string-escape') {
        mode = 'in-string';
        if (keyMatchPos >= 0) keyMatchPos = -1;
        continue;
      }
      if (mode === 'in-string') {
        if (byte === BACKSLASH_BYTE) {
          mode = 'in-string-escape';
          continue;
        }
        if (byte === QUOTE_BYTE) {
          mode = keyMatchPos === TARGET_KEY.length ? 'awaiting-colon' : 'scan';
          keyMatchPos = -1;
          continue;
        }
        if (keyMatchPos >= 0) {
          keyMatchPos = keyMatchPos < TARGET_KEY.length && byte === TARGET_KEY.charCodeAt(keyMatchPos)
            ? keyMatchPos + 1
            : -1;
        }
        continue;
      }
      if (isJsonWhitespace(byte)) continue;
      if (mode === 'awaiting-colon') {
        if (byte === COLON_BYTE) {
          mode = 'awaiting-value';
          continue;
        }
        mode = 'scan';
      }
      if (mode === 'awaiting-value') {
        if (byte === QUOTE_BYTE) {
          mode = 'found';
          return;
        }
        mode = 'scan';
      }
      if (byte === QUOTE_BYTE) {
        mode = 'in-string';
        keyMatchPos = depth === 1 && expectsKeyAtDepthOne === 1 ? 0 : -1;
        expectsKeyAtDepthOne = 0;
        continue;
      }
      if (byte === OPEN_BRACE_BYTE) {
        depth += 1;
        expectsKeyAtDepthOne = depth === 1 ? 1 : 0;
        continue;
      }
      if (byte === CLOSE_BRACE_BYTE) {
        depth = Math.max(0, depth - 1);
        expectsKeyAtDepthOne = 0;
        continue;
      }
      if (byte === OPEN_BRACKET_BYTE) {
        depth += 1;
        expectsKeyAtDepthOne = 0;
        continue;
      }
      if (byte === CLOSE_BRACKET_BYTE) {
        depth = Math.max(0, depth - 1);
        expectsKeyAtDepthOne = 0;
        continue;
      }
      if (byte === COMMA_BYTE && depth === 1) {
        expectsKeyAtDepthOne = 1;
      }
    }
  }

  return {
    push,
    hasTopLevelAgentId: () => mode === 'found',
  };
}

function hasTopLevelAgentId(body: Buffer): boolean {
  const scanner = createTopLevelAgentIdScanner();
  scanner.push(body);
  return scanner.hasTopLevelAgentId();
}

export { HOOK_BODY_CAP_BYTES, SILENT_OVERSIZE_HOOK_EVENTS, createTopLevelAgentIdScanner, hasTopLevelAgentId };
