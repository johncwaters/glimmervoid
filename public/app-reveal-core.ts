export const MAX_REVEAL_WAIT_MS = 2500;

type AppRevealDecision = 'reveal' | 'wait';

export type RevealInput = 'snapshot' | 'settings';

export function decideAppReveal({ awaitedInputCount, connectingTerminalCount, msSinceConnected }: { awaitedInputCount: number; connectingTerminalCount: number; msSinceConnected: number }): AppRevealDecision {
  if (!(msSinceConnected < MAX_REVEAL_WAIT_MS)) return 'reveal';
  if (awaitedInputCount > 0) return 'wait';
  if (connectingTerminalCount > 0) return 'wait';
  return 'reveal';
}
