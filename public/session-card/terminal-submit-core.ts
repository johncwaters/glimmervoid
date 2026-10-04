import { TERMINAL_ENTER } from './ime-core.ts';

export function isTerminalSubmitKeystroke(data: string) {
  return data === TERMINAL_ENTER;
}
