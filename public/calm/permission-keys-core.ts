import { STATES } from '#shared/states.ts';

export interface PermissionKeystroke {
  data: string;
}

export interface TimedKeystroke extends PermissionKeystroke {
  delayBeforeMs: number;
}

export interface RejectAndInstructPlan {
  dismissPrompt: readonly PermissionKeystroke[];
  instruct: readonly TimedKeystroke[];
}

interface PermissionKeys {
  approve: readonly PermissionKeystroke[];
  dismissPrompt: readonly PermissionKeystroke[];
  instruct: (instruction: string) => readonly TimedKeystroke[];
}

const ESCAPE = String.fromCharCode(27);

const PERMISSION_KEYS_BY_AGENT: Readonly<Record<string, PermissionKeys>> = Object.freeze({
  'claude-code': {
    approve: [{ data: '\r' }],
    dismissPrompt: [{ data: ESCAPE }],
    instruct: (instruction: string) => [{ data: instruction, delayBeforeMs: 0 }, { data: '\r', delayBeforeMs: 800 }],
  },
});

export const INSTRUCTION_POLL_INTERVAL_MS = 200;
export const INSTRUCTION_WAIT_TIMEOUT_MS = 10_000;

function permissionKeysFor(agent: string | null | undefined): PermissionKeys | null {
  if (typeof agent !== 'string' || !Object.hasOwn(PERMISSION_KEYS_BY_AGENT, agent)) return null;
  return PERMISSION_KEYS_BY_AGENT[agent];
}

export function hasPermissionKeys(agent: string | null | undefined): boolean {
  return permissionKeysFor(agent) !== null;
}

export function approveKeystrokes(agent: string | null | undefined): readonly PermissionKeystroke[] | null {
  return permissionKeysFor(agent)?.approve ?? null;
}

export function rejectAndInstructKeystrokes(agent: string | null | undefined, instruction: string): RejectAndInstructPlan | null {
  const keys = permissionKeysFor(agent);
  if (!keys) return null;
  return { dismissPrompt: keys.dismissPrompt, instruct: keys.instruct(instruction) };
}

export function isAnyPromptShowing(currentState: string, pendingPromptKind: string | null | undefined): boolean {
  return currentState === STATES.WAITING && typeof pendingPromptKind === 'string' && pendingPromptKind !== '';
}

export type InstructionDelivery = 'send' | 'wait' | 'give-up';

export function decideInstructionDelivery({ currentState, pendingPromptKind, elapsedMs }: {
  currentState: string;
  pendingPromptKind: string | null | undefined;
  elapsedMs: number;
}): InstructionDelivery {
  if (!isAnyPromptShowing(currentState, pendingPromptKind)) return 'send';
  if (elapsedMs >= INSTRUCTION_WAIT_TIMEOUT_MS) return 'give-up';
  return 'wait';
}
