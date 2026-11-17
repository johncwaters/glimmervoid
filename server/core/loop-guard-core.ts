import { LOOP_GUARD_TURNS_RANGE } from '../../shared/settings-ranges.ts';

type LoopGuardState = { turnsWithoutProgress: number; lastSig: string | null };
type LoopGuardEvent = { kind: 'turn-end'; sig: string | null } | { kind: 'operator-input' } | { kind: 'acted' };
type LoopGuardLimits = { maxTurnsWithoutProgress: number | null; onStuck: 'flag' | 'stop' };
type LoopGuardDecision = { kind: 'ok' } | { kind: 'flag' | 'stop'; reason: string };

const INITIAL_LOOP_GUARD_STATE: LoopGuardState = Object.freeze({ turnsWithoutProgress: 0, lastSig: null });

function reduceLoopGuard(state: LoopGuardState, event: LoopGuardEvent): LoopGuardState {
  if (event.kind !== 'turn-end') return { turnsWithoutProgress: 0, lastSig: state.lastSig };
  if (event.sig === null || event.sig !== state.lastSig) return { turnsWithoutProgress: 0, lastSig: event.sig };
  return { turnsWithoutProgress: state.turnsWithoutProgress + 1, lastSig: event.sig };
}

function decideLoopGuard(state: LoopGuardState, limits: LoopGuardLimits): LoopGuardDecision {
  if (limits.maxTurnsWithoutProgress === null || state.turnsWithoutProgress < limits.maxTurnsWithoutProgress) return { kind: 'ok' };
  const action = limits.onStuck === 'stop' ? 'Glimmervoid stopped it' : 'it may be stuck in a loop';
  return { kind: limits.onStuck, reason: `${state.turnsWithoutProgress} turns in a row ended with the worktree unchanged and no input from you, so ${action}` };
}

function readLoopGuardLimits(raw: unknown): LoopGuardLimits {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const turns = source.maxTurnsWithoutProgress;
  const isTurnsValid = Number.isInteger(turns) && Number(turns) >= LOOP_GUARD_TURNS_RANGE.min && Number(turns) <= LOOP_GUARD_TURNS_RANGE.max;
  return { maxTurnsWithoutProgress: isTurnsValid ? Number(turns) : null, onStuck: source.onStuck === 'stop' ? 'stop' : 'flag' };
}

export { INITIAL_LOOP_GUARD_STATE, decideLoopGuard, readLoopGuardLimits, reduceLoopGuard };
