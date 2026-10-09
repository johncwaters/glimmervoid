export const MAX_REVEAL_WAIT_MS = 2500;

export type AppRevealDecision = 'reveal' | 'wait';

export function decideAppReveal({ hasSnapshot, connectingTerminalCount, msSinceConnected }: { hasSnapshot: boolean; connectingTerminalCount: number; msSinceConnected: number }): AppRevealDecision {
  if (!(msSinceConnected < MAX_REVEAL_WAIT_MS)) return 'reveal';
  if (!hasSnapshot) return 'wait';
  if (connectingTerminalCount > 0) return 'wait';
  return 'reveal';
}
