import { STATES } from "../../shared/states.ts";
import type { SessionState } from "../../shared/states.ts";

type WaitingInputDecision = "ignore" | "acknowledge" | "end-waiting";

interface WaitingInputContext {
  state: string;
  hasHookAwaitingInput: boolean;
  pendingPromptKind: string | null;
  isQuestionPrompt: boolean;
  input: string;
}

const HOOK_RAISED_PROMPT_KINDS: ReadonlySet<string> = new Set(["permission", "plan", "elicitation"]);

const TERMINAL_REPORT_PATTERN = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[\d+;\d+;\d+M|\x1b\[M[\s\S]{3}|\x1b\[[IO]/g;

const TERMINAL_QUERY_REPLY_PATTERN = /\x1b\[[?>]?[\d;]*(?:\$y|[cRnt])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\/g;

function isOperatorKeystroke(input: string): boolean {
  return input.replace(TERMINAL_REPORT_PATTERN, "").replace(TERMINAL_QUERY_REPLY_PATTERN, "") !== "";
}

const NON_SUBMITTING_CARRIAGE_RETURN_PATTERN = /\x1b\[200~[\s\S]*?\x1b\[201~|\x1b\r/g;

function isPromptSubmit(input: string): boolean {
  return isOperatorKeystroke(input) && input.replace(NON_SUBMITTING_CARRIAGE_RETURN_PATTERN, "").includes("\r");
}

const COMPOSER_SUBMIT_STATES: readonly SessionState[] = [STATES.IDLE, STATES.COMPLETE];

function isComposerSubmit(input: string, state: SessionState): boolean {
  return COMPOSER_SUBMIT_STATES.includes(state) && isPromptSubmit(input);
}

const LONE_ESCAPE = "\x1b";

const OPTION_DIGIT_SHORTCUT_PATTERN = /^[1-9]$/;

function isPromptClosingKeystroke(input: string, isQuestionPrompt: boolean): boolean {
  if (input === LONE_ESCAPE) return true;
  if (isQuestionPrompt) return false;
  return input.endsWith("\r") || OPTION_DIGIT_SHORTCUT_PATTERN.test(input);
}

function decideWaitingInput({ state, hasHookAwaitingInput, pendingPromptKind, isQuestionPrompt, input }: WaitingInputContext): WaitingInputDecision {
  if (state !== STATES.WAITING) return "ignore";
  if (!isOperatorKeystroke(input)) return "ignore";
  const isHookRaisedPrompt = pendingPromptKind !== null && HOOK_RAISED_PROMPT_KINDS.has(pendingPromptKind);
  if (!hasHookAwaitingInput || !isHookRaisedPrompt) return "end-waiting";
  if (isPromptClosingKeystroke(input, isQuestionPrompt)) return "end-waiting";
  return "acknowledge";
}

export { decideWaitingInput, isComposerSubmit, isOperatorKeystroke, isPromptSubmit };
