import { STATES } from "../../shared/states.ts";

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

function isTerminalReportOnly(input: string): boolean {
  return input.replace(TERMINAL_REPORT_PATTERN, "") === "";
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
  if (isTerminalReportOnly(input)) return "ignore";
  const isHookRaisedPrompt = pendingPromptKind !== null && HOOK_RAISED_PROMPT_KINDS.has(pendingPromptKind);
  if (!hasHookAwaitingInput || !isHookRaisedPrompt) return "end-waiting";
  if (isPromptClosingKeystroke(input, isQuestionPrompt)) return "end-waiting";
  return "acknowledge";
}

export { decideWaitingInput, isTerminalReportOnly };
export type { WaitingInputContext, WaitingInputDecision };
