
import fs from "node:fs";
import { buildAntiSlopArgs } from "../core/anti-slop-prompt.ts";
import { resolveAgentCommand, buildAgentSpawnCommand } from "../core/spawn-command.ts";
import { isBrailleChar, isSpinnerChar } from "../core/title-classifier-core.ts";
import type { PathLookupExecFile, ResolvedCommand } from "../core/spawn-command.ts";
import { buildAgentEnv } from "../core/spawn-env.ts";
import type { AgentEnvOptions, AgentEnvProfile, SpawnEnv } from "../core/spawn-env.ts";
import { execFileSync } from "../../server/child-process-safe.ts";
import type { AgentAdapterShape, AgentArgsOptions, AgentHookProfile, AgentSpawnCommandOptions } from "./index.ts";
import { PLAN_TOOL_NAME } from "../../shared/contracts/index.ts";
import { ASK_USER_QUESTION_TOOL_NAME, PendingPromptQuestion, PROMPT_DETAIL_HIDDEN_CHARACTERS, type HookPayload, type PendingPromptDetail } from "../../shared/contracts/index.ts";
import { firstDetailLine, toolDetailFieldValue } from "../../shared/tool-detail.ts";

const ID = "claude-code";
const COMMAND_NAME = "claude";

const envProfile: AgentEnvProfile = {
  scrub: [
    "CLAUDECODE",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_CHILD_SESSION",
  ],
  set: { CLAUDE_CODE_NO_FLICKER: "1", FORCE_HYPERLINK: "1" },
};

const KNOWN_IDLE_CODEPOINTS = new Set([0x2733]);

function isKnownIdleChar(char: string | null | undefined): boolean {
  if (!char) return false;
  return KNOWN_IDLE_CODEPOINTS.has(char.codePointAt(0) ?? 0);
}

const titleProfile = {
  isSpinnerChar,
  isIdleChar: isKnownIdleChar,
  dropsLeadingAscii: true,
  unknownGlyphHint: "If this is a new idle glyph, add it to KNOWN_IDLE_CODEPOINTS.",
  taskTitle: { readsTranscriptTitle: true, genericTitles: ["Claude Code"], agentSuffix: null },
};

function notificationType(payload: HookPayload | null | undefined): string {
  return String((payload && (payload.notification_type || payload.notificationType)) || "").toLowerCase();
}

function mapHookConfidence(event: string, payload?: HookPayload): string | null {
  const e = String(event || "").toLowerCase();
  if (e === "notification" && notificationType(payload) === "idle_prompt") return "low";
  return null;
}

function mapHookPromptKind(event: string, payload?: HookPayload): string | null {
  const e = String(event || "").toLowerCase();
  if (e === "permissionrequest") {
    if (String(payload?.tool_name || "") === PLAN_TOOL_NAME) return "plan";
    return "permission";
  }
  if (e === "notification") {
    const t = notificationType(payload);
    if (t === "permission_prompt") return "permission";
    if (t.startsWith("elicitation")) return "elicitation";
  }
  return null;
}

function mapHookPromptDetail(event: string, payload?: HookPayload): PendingPromptDetail | null {
  if (String(event || "").toLowerCase() !== "permissionrequest") return null;
  if (mapHookPromptKind(event, payload) !== "permission") return null;
  const toolName = payload?.tool_name;
  if (typeof toolName !== "string" || !toolName) return null;
  const fieldValue = toolDetailFieldValue(toolName, payload?.tool_input);
  const summary = fieldValue === null ? "" : firstDetailLine(fieldValue);
  const isComplete = isWholeBashCommandShown(toolName, payload?.tool_input, fieldValue, summary);
  return { toolName: firstDetailLine(toolName), summary, isComplete, question: answerableQuestionOf(toolName, payload?.tool_input) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function answerableQuestionOf(toolName: string, toolInput: unknown): PendingPromptQuestion | null {
  if (toolName !== ASK_USER_QUESTION_TOOL_NAME || !isRecord(toolInput)) return null;
  const questions = toolInput.questions;
  if (!Array.isArray(questions) || questions.length !== 1) return null;
  const [entry] = questions;
  if (!isRecord(entry) || typeof entry.question !== "string" || !Array.isArray(entry.options)) return null;
  const optionLabels = entry.options.flatMap((option) => (isRecord(option) && typeof option.label === "string" ? [option.label] : []));
  if (optionLabels.length !== entry.options.length) return null;
  const parsedQuestion = PendingPromptQuestion.safeParse({ text: entry.question, options: optionLabels, multiSelect: entry.multiSelect === true });
  return parsedQuestion.success ? parsedQuestion.data : null;
}

const DISPLAY_IRRELEVANT_BASH_INPUT_KEYS = new Set(["command", "description", "timeout"]);

function hasOnlyDisplayIrrelevantBashInputKeys(toolInput: unknown): boolean {
  if (!toolInput || typeof toolInput !== "object") return false;
  return Reflect.ownKeys(toolInput).every((key) => typeof key === "string" && DISPLAY_IRRELEVANT_BASH_INPUT_KEYS.has(key));
}

function isWholeBashCommandShown(toolName: string, toolInput: unknown, fieldValue: string | null, summary: string): boolean {
  if (toolName !== "Bash" || fieldValue === null) return false;
  if (!hasOnlyDisplayIrrelevantBashInputKeys(toolInput)) return false;
  if (PROMPT_DETAIL_HIDDEN_CHARACTERS.test(fieldValue)) return false;
  return summary === fieldValue;
}

function mapHookToSignal(event: string, payload?: HookPayload): string | null {
  const e = String(event || "").toLowerCase();
  switch (e) {
    case "sessionstart":
      return "session-start";
    case "precompact":
      return "compaction-start";
    case "postcompact":
      return "compaction-end";
    case "sessionend":
      return "session-end";
    case "userpromptsubmit":
      return "resume";
    case "stop":
      return "ready";
    case "subagentstart":
      return "subagent-start";
    case "subagentstop":
      return "subagent-stop";
    case "taskcreated":
      return "task-created";
    case "taskcompleted":
      return "task-completed";
    case "teammateidle":
      return "teammate-idle";
    case "permissionrequest":
      return "awaiting-input";
    case "posttooluse": {
      const tool = String(payload?.tool_name || "");
      if (tool === "ScheduleWakeup") return "wakeup-scheduled";
      if (tool === "CronCreate") return "cron-created";
      if (tool === "CronDelete") return "cron-deleted";
      return null;
    }
    case "notification": {
      const t = notificationType(payload);
      if (t === "idle_prompt") return "ready";
      if (t === "permission_prompt" || t.startsWith("elicitation")) return "awaiting-input";
      return null;
    }
    default:
      return null;
  }
}

const hooks: AgentHookProfile = {
  mapSignal: mapHookToSignal,
  mapConfidence: mapHookConfidence,
  mapPromptKind: mapHookPromptKind,
  mapPromptDetail: mapHookPromptDetail,
  injection: { kind: "settings-file" },
};

function resolveCommand(
  { platform, execFile = execFileSync, pathExists = fs.existsSync }: {
    platform?: NodeJS.Platform;
    execFile?: PathLookupExecFile;
    pathExists?: (candidate: string) => boolean;
  } = {},
): ResolvedCommand {
  return resolveAgentCommand({
    name: COMMAND_NAME,
    platform: platform || process.platform,
    execFile,
    pathExists,
  });
}

function buildSpawnCommand(
  { platform, resolved, settingsArgs: injectedSettingsArgs = [], agentArgs = [] }: AgentSpawnCommandOptions,
): { file: string; args: string[] } {
  return buildAgentSpawnCommand({
    name: COMMAND_NAME,
    platform,
    resolved,
    argGroups: [injectedSettingsArgs, agentArgs],
  });
}

function buildEnv(baseEnv: SpawnEnv, extraEnv: SpawnEnv | null | undefined, options?: AgentEnvOptions): SpawnEnv {
  return buildAgentEnv(baseEnv, extraEnv, envProfile, options);
}

const settingsArgs = (settingsPath: string): string[] => ["--settings", settingsPath];

function buildArgs({
  dangerouslySkipPermissions = false,
  resumeSessionId = null,
  extraArgs = [],
  antiSlopPrompt = false,
  initialPrompt = null,
}: AgentArgsOptions = {}): string[] {
  const args = dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : [];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  if (extraArgs.length > 0) args.push(...extraArgs);
  args.push(...buildAntiSlopArgs(antiSlopPrompt));
  if (initialPrompt != null) args.push(initialPrompt);
  return args;
}

const claudeCode = {
  id: ID,
  label: "Claude Code",
  usageVendor: "claude",
  commandName: COMMAND_NAME,
  envProfile,
  titleProfile,
  hooks,
  resolveCommand,
  buildSpawnCommand,
  buildEnv,
  buildArgs,
  settingsArgs,
  capabilities: {
    hooks: true,
    awaitingInput: true,
    backgroundAgents: true,
    resume: true,
    statusLine: true,
    rtk: true,
    saneYolo: true,
    antiSlop: true,
    compactQuiet: true,
    skipPermissionsFlag: true,
    headless: true,
  },
  isBrailleChar,
  isSpinnerChar,
  isKnownIdleChar,
  mapHookToSignal,
  mapHookConfidence,
  mapHookPromptKind,
  mapHookPromptDetail,
} satisfies AgentAdapterShape;

export default claudeCode;
