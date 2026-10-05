import { PROMPT_QUESTION_MAX_OPTIONS } from '#shared/contracts/session.ts';
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
  answerWithOption: (optionIndex: number) => readonly PermissionKeystroke[];
  answerWithText: (optionCount: number, text: string) => readonly TimedKeystroke[];
  reply: (text: string) => readonly TimedKeystroke[];
}

const ESCAPE = String.fromCharCode(27);

const PERMISSION_KEYS_BY_AGENT: Readonly<Record<string, PermissionKeys>> = Object.freeze({
  'claude-code': {
    approve: [{ data: '\r' }],
    dismissPrompt: [{ data: ESCAPE }],
    instruct: (instruction: string) => [{ data: instruction, delayBeforeMs: 0 }, { data: '\r', delayBeforeMs: 800 }],
    answerWithOption: (optionIndex: number) => [{ data: String(optionIndex + 1) }],
    answerWithText: (optionCount: number, text: string) => [
      { data: String(optionCount + 1), delayBeforeMs: 0 },
      { data: text, delayBeforeMs: 800 },
      { data: '\r', delayBeforeMs: 800 },
    ],
    reply: (text: string) => [{ data: text, delayBeforeMs: 0 }, { data: '\r', delayBeforeMs: 300 }],
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

function isAnswerableOptionCount(optionCount: number): boolean {
  return Number.isInteger(optionCount) && optionCount >= 1 && optionCount <= PROMPT_QUESTION_MAX_OPTIONS;
}

export function answerWithOptionKeystrokes(
  agent: string | null | undefined,
  optionIndex: number,
  optionCount: number,
  isMultiSelect: boolean,
): readonly PermissionKeystroke[] | null {
  const keys = permissionKeysFor(agent);
  if (!keys || isMultiSelect || !isAnswerableOptionCount(optionCount)) return null;
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= optionCount) return null;
  return keys.answerWithOption(optionIndex);
}

export function answerWithTextKeystrokes(
  agent: string | null | undefined,
  optionCount: number,
  text: string,
  isMultiSelect: boolean,
): readonly TimedKeystroke[] | null {
  const keys = permissionKeysFor(agent);
  if (!keys || isMultiSelect || !isAnswerableOptionCount(optionCount) || !text.trim()) return null;
  return keys.answerWithText(optionCount, text);
}

export function replyKeystrokes(agent: string | null | undefined, text: string): readonly TimedKeystroke[] | null {
  const keys = permissionKeysFor(agent);
  if (!keys || !text.trim()) return null;
  return keys.reply(text);
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
