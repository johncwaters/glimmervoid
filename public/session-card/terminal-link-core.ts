export type TerminalLinkState = 'live' | 'connecting' | 'none';

export function decideTerminalLinkState({ hasTerminal, isSocketOpen, isInputHeld }: { hasTerminal: boolean; isSocketOpen: boolean; isInputHeld: boolean }): TerminalLinkState {
  if (!hasTerminal) return 'none';
  if (isInputHeld) return 'connecting';
  if (!isSocketOpen) return 'connecting';
  return 'live';
}
