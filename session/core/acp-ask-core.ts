import { z } from "zod";
import type { PermissionOption, PermissionOptionKind, ToolKind } from "@agentclientprotocol/sdk";
import { ConversationQuestion } from "../../shared/contracts/session.ts";
import type { ConversationAnswers, ConversationApproval, PermissionDecision } from "../../shared/contracts/session.ts";
import { isRecord, parseJsonOrNull } from "../../shared/coerce.ts";
import { claudePermissionApprovalFor } from "./claude-approval-core.ts";
import type { DriverPermissionOutcome, DriverQuestionAnswer } from "../drivers/driver.ts";

type AcpPermissionChoice = "allow" | "deny";
type AcpPermissionChoices = Readonly<Record<AcpPermissionChoice, string | null>>;
type RecordedOption = Readonly<{ optionId: string; kind: PermissionOptionKind }>;
type QuestionTextSource = "message" | "title";

interface AcpPermissionFacts {
  title: string | null;
  toolKind: ToolKind | null;
  rawInput: unknown;
  locationPaths: readonly string[];
}

interface AcpQuestionFacts {
  message: string | null;
  requestedSchema: Record<string, unknown>;
}

interface AcpQuestionField {
  key: string;
  questionText: string;
  valueByLabel: ReadonlyMap<string, string>;
  freeTextKey: string | null;
}

interface AcpQuestionForm {
  questions: ConversationQuestion[];
  fields: readonly AcpQuestionField[];
}

const ACP_PERMISSION_OPTIONS_BY_AGENT: Readonly<Record<string, Readonly<Record<AcpPermissionChoice, readonly RecordedOption[]>>>> = Object.freeze({
  "claude-code": {
    allow: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "exit-plan-default", kind: "allow_once" }],
    deny: [{ optionId: "reject", kind: "reject_once" }],
  },
  codex: {
    allow: [{ optionId: "allow_once", kind: "allow_once" }],
    deny: [{ optionId: "cancel", kind: "reject_once" }],
  },
  antigravity: {
    allow: [{ optionId: "allow", kind: "allow_once" }],
    deny: [{ optionId: "deny", kind: "reject_once" }],
  },
});

const QUESTION_TEXT_SOURCE_BY_AGENT: Readonly<Record<string, QuestionTextSource>> = Object.freeze({ "claude-code": "message", codex: "title", antigravity: "title" });

const CANCELLED_PERMISSION: DriverPermissionOutcome = Object.freeze({ outcome: "cancelled" });
const CANCELLED_QUESTION: DriverQuestionAnswer = Object.freeze({ action: "cancel" });
const DECLINED_QUESTION: DriverQuestionAnswer = Object.freeze({ action: "decline" });
const TOOL_NAME_MAX_CHARS = 200;
const MAX_QUESTIONS_PER_ASK = 4;
const COMMAND_INPUT_KEYS = ["command", "CommandLine"];
const PATH_INPUT_KEYS = ["file_path", "path", "Path"];
const CWD_INPUT_KEYS = ["cwd"];
const SANE_YOLO_TOOL_BY_KIND: Readonly<Partial<Record<ToolKind, string>>> = Object.freeze({ edit: "Write", delete: "Write", move: "Write", read: "Read", search: "Grep" });

const ChoiceProperty = z.object({
  type: z.literal("string"),
  title: z.string().optional(),
  oneOf: z.array(z.object({ const: z.string().min(1), title: z.string().optional(), description: z.string().optional() })).min(1),
});
const FreeTextProperty = z.object({ type: z.literal("string"), oneOf: z.never().optional(), enum: z.never().optional() });
const RequestedSchema = z.object({ properties: z.record(z.string(), z.unknown()) });
const SaneYoloDenial = z.object({ hookSpecificOutput: z.object({ permissionDecision: z.literal("deny"), permissionDecisionReason: z.string().default("") }) });

function permissionChoicesOf(agentId: string, options: readonly PermissionOption[]): AcpPermissionChoices {
  const table = ACP_PERMISSION_OPTIONS_BY_AGENT[agentId];
  const optionIdFor = (choice: AcpPermissionChoice): string | null => {
    const recorded = table?.[choice] ?? [];
    return options.find((option) => recorded.some((known) => known.optionId === option.optionId && known.kind === option.kind))?.optionId ?? null;
  };
  return { allow: optionIdFor("allow"), deny: optionIdFor("deny") };
}

function canOperatorDecide(choices: AcpPermissionChoices): boolean {
  return choices.allow !== null && choices.deny !== null;
}

function isPlanExitPermission(choices: AcpPermissionChoices): boolean {
  return choices.allow === "exit-plan-default";
}

function permissionOutcomeFor(choices: AcpPermissionChoices, choice: AcpPermissionChoice): DriverPermissionOutcome {
  const optionId = choices[choice] ?? choices.deny;
  return optionId === null ? CANCELLED_PERMISSION : { outcome: "selected", optionId };
}

function permissionOutcomeOfDecision(choices: AcpPermissionChoices, decision: PermissionDecision): DriverPermissionOutcome {
  return permissionOutcomeFor(choices, decision === "allow" ? "allow" : "deny");
}

function permissionApprovalOf(facts: AcpPermissionFacts, requestId: string): ConversationApproval {
  const toolName = (facts.title ?? facts.toolKind ?? "").slice(0, TOOL_NAME_MAX_CHARS) || "tool";
  const toolInput = isRecord(facts.rawInput) ? facts.rawInput : { paths: facts.locationPaths };
  const approval = claudePermissionApprovalFor({ toolName, toolInput, agentKey: "" }, requestId);
  return approval.summary.length > 0 ? approval : { ...approval, summary: toolName };
}

function firstTextOf(input: Record<string, unknown>, keys: readonly string[]): string | null {
  const value = keys.map((key) => input[key]).find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
  return typeof value === "string" ? value : null;
}

function saneYoloPayloadsOf(facts: AcpPermissionFacts, sessionCwd: string): Record<string, unknown>[] {
  const input = isRecord(facts.rawInput) ? facts.rawInput : {};
  const cwd = firstTextOf(input, CWD_INPUT_KEYS) ?? sessionCwd;
  const command = firstTextOf(input, COMMAND_INPUT_KEYS);
  if (command !== null) return [{ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd }];
  const toolName = facts.toolKind === null ? undefined : SANE_YOLO_TOOL_BY_KIND[facts.toolKind];
  if (toolName === undefined) return [];
  const paths = new Set([firstTextOf(input, PATH_INPUT_KEYS), ...facts.locationPaths].filter((path): path is string => path !== null));
  return [...paths].map((filePath) => ({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: { file_path: filePath }, cwd }));
}

function saneYoloDenialOf(hookOutput: string): string | null {
  const parsed = SaneYoloDenial.safeParse(parseJsonOrNull(hookOutput));
  return parsed.success ? parsed.data.hookSpecificOutput.permissionDecisionReason : null;
}

function questionTextOf(source: QuestionTextSource, message: string | null, title: string, choiceCount: number): { question: string; header: string } {
  if (source === "message" && message !== null && choiceCount === 1) return { question: message, header: title };
  return { question: title, header: "" };
}

function questionFormOf(agentId: string, facts: AcpQuestionFacts): AcpQuestionForm | null {
  const schema = RequestedSchema.safeParse(facts.requestedSchema);
  if (!schema.success) return null;
  const entries = Object.entries(schema.data.properties);
  const choiceEntries = entries.flatMap(([key, value]) => {
    const choice = ChoiceProperty.safeParse(value);
    return choice.success ? [{ key, choice: choice.data }] : [];
  });
  const otherEntries = entries.filter(([key]) => !choiceEntries.some((entry) => entry.key === key));
  if (choiceEntries.length === 0 || choiceEntries.length > MAX_QUESTIONS_PER_ASK) return null;
  if (otherEntries.some(([, value]) => !FreeTextProperty.safeParse(value).success)) return null;
  const freeTextKeys = otherEntries.map(([key]) => key);
  const freeTextKeyByChoiceKey = new Map(choiceEntries.map((entry) => [entry.key, freeTextKeys.find((key) => key.startsWith(`${entry.key}_`)) ?? null]));
  const pairedFreeTextKeys = new Set(freeTextKeyByChoiceKey.values());
  if (freeTextKeys.some((key) => !pairedFreeTextKeys.has(key))) return null;
  const source = QUESTION_TEXT_SOURCE_BY_AGENT[agentId] ?? "title";
  const questions: ConversationQuestion[] = [];
  const fields: AcpQuestionField[] = [];
  for (const { key, choice } of choiceEntries) {
    const texts = questionTextOf(source, facts.message, choice.title ?? key, choiceEntries.length);
    const labeledOptions = choice.oneOf.map((option) => ({ label: option.title ?? option.const, description: option.description ?? "", value: option.const }));
    const parsed = ConversationQuestion.safeParse({ ...texts, options: labeledOptions.map(({ label, description }) => ({ label, description })), multiSelect: false });
    if (!parsed.success) return null;
    questions.push(parsed.data);
    fields.push({ key, questionText: parsed.data.question, valueByLabel: new Map(labeledOptions.map(({ label, value }) => [label, value])), freeTextKey: freeTextKeyByChoiceKey.get(key) ?? null });
  }
  const isEachQuestionDistinct = new Set(questions.map((question) => question.question)).size === questions.length;
  return isEachQuestionDistinct ? { questions, fields } : null;
}

function questionApprovalOf(form: AcpQuestionForm, requestId: string): ConversationApproval {
  return { requestId, kind: "question", summary: form.questions[0].question, isSummaryTruncated: false, questions: form.questions };
}

function questionAnswerOf(form: AcpQuestionForm, answers: ConversationAnswers): DriverQuestionAnswer | null {
  const content: Record<string, string> = {};
  for (const field of form.fields) {
    const answerText = (Object.hasOwn(answers, field.questionText) ? answers[field.questionText] : "").trim();
    if (answerText.length === 0) return null;
    const chosenValue = field.valueByLabel.get(answerText);
    if (chosenValue !== undefined) {
      content[field.key] = chosenValue;
      continue;
    }
    if (field.freeTextKey === null) return null;
    content[field.freeTextKey] = answerText;
  }
  return { action: "accept", content };
}

function questionAnswerOfDecision(decision: PermissionDecision): DriverQuestionAnswer | null {
  return decision === "deny" ? DECLINED_QUESTION : null;
}

function doesQuestionSurviveTurnEnd(agentId: string, toolCallId: string | null): boolean {
  return agentId === "codex" && toolCallId === null;
}

export {
  CANCELLED_PERMISSION,
  CANCELLED_QUESTION,
  DECLINED_QUESTION,
  canOperatorDecide,
  doesQuestionSurviveTurnEnd,
  isPlanExitPermission,
  permissionApprovalOf,
  permissionChoicesOf,
  permissionOutcomeFor,
  permissionOutcomeOfDecision,
  questionAnswerOf,
  questionAnswerOfDecision,
  questionApprovalOf,
  questionFormOf,
  saneYoloDenialOf,
  saneYoloPayloadsOf,
};
export type { AcpPermissionChoices };
