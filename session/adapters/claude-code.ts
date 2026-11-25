import fs from "node:fs";
import { EXIT_PLAN_MODE_TOOL_NAME } from "../../shared/contracts/plan-gate.ts";
import { isBrailleChar, isSpinnerChar } from "../core/title-classifier-core.ts";
import type { AgentEnvProfile, SpawnEnv } from "../core/spawn-env.ts";
import { createClaudeFolderTrust } from "./claude-trust.ts";
import { mainCheckoutOf } from "../../server/git-checkout-root.ts";
import { CLAUDE_HOME_PROFILE } from "../core/agent-home-core.ts";
import type { AgentAdapterShape, AgentArgsOptions, AgentHookProfile } from "./index.ts";
import { pathCommandLaunch } from "./path-command-launch.ts";
import { ASK_USER_QUESTION_TOOL_NAME } from "../../shared/contracts/session.ts";
import type { HookPayload } from "../../shared/contracts/index.ts";
import { isRecord } from "../../shared/coerce.ts";
import { SIGNED_IN_SIGNAL, SIGN_IN_PROMPT_KIND, RATE_LIMIT_PROMPT_KIND } from "../../shared/states.ts";
import { describeInstalledClaudeHooks } from "../../detection/settings-injector.ts";


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

function isAuthenticationFailure(event: string, payload?: HookPayload): boolean {
  return String(event || "").toLowerCase() === "stopfailure" && payload?.error === "authentication_failed";
}

function isRateLimitStop(event: string, payload?: HookPayload): boolean {
  return String(event || "").toLowerCase() === "stopfailure" && payload?.error === "rate_limit";
}

function mapHookConfidence(event: string, payload?: HookPayload): string | null {
  const e = String(event || "").toLowerCase();
  if (e !== "notification") return null;
  const t = notificationType(payload);
  if (t === "idle_prompt") return "low";
  return null;
}

function mapHookPromptKind(event: string, payload?: HookPayload): string | null {
  const e = String(event || "").toLowerCase();
  if (isAuthenticationFailure(event, payload)) return SIGN_IN_PROMPT_KIND;
  if (isRateLimitStop(event, payload)) return RATE_LIMIT_PROMPT_KIND;
  if (e === "permissionrequest") {
    if (String(payload?.tool_name || "") === EXIT_PLAN_MODE_TOOL_NAME) return "plan";
    return "permission";
  }
  if (e === "notification") {
    const t = notificationType(payload);
    if (t === "permission_prompt") return "permission";
    if (t.startsWith("elicitation")) return "elicitation";
  }
  return null;
}

function mapHookPromptToolName(event: string, payload?: HookPayload): string | null {
  if (String(event || "").toLowerCase() !== "permissionrequest") return null;
  if (mapHookPromptKind(event, payload) !== "permission") return null;
  const toolName = payload?.tool_name;
  if (typeof toolName !== "string" || !toolName) return null;
  return toolName;
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
    case "stopfailure":
      return isAuthenticationFailure(event, payload) || isRateLimitStop(event, payload) ? "awaiting-input" : "ready";
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
      if (tool === ASK_USER_QUESTION_TOOL_NAME) return "working";
      if (isRecord(payload?.tool_response) && typeof payload.tool_response.backgroundTaskId === "string") return "background-task-launched";
      return null;
    }
    case "notification": {
      const t = notificationType(payload);
      if (t === "idle_prompt") return "ready";
      if (t === "auth_success") return SIGNED_IN_SIGNAL;
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
  mapPromptToolName: mapHookPromptToolName,
  injection: { kind: "settings-file" },
  describeInstalledHooks: describeInstalledClaudeHooks,
};

const { resolveCommand, buildSpawnCommand, buildEnv } = pathCommandLaunch(COMMAND_NAME, envProfile);

const settingsArgs = (settingsPath: string): string[] => ["--settings", settingsPath];

function buildArgs({
  dangerouslySkipPermissions = false,
  resumeSessionId = null,
  extraArgs = [],
  initialPrompt = null,
}: AgentArgsOptions = {}): string[] {
  const args = dangerouslySkipPermissions ? ["--dangerously-skip-permissions"] : [];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  for (let index = 0; index < extraArgs.length; index += 1) {
    const argument = extraArgs[index];
    if (resumeSessionId && argument === "--session-id") {
      index += 1;
      continue;
    }
    if (resumeSessionId && argument.startsWith("--session-id=")) continue;
    args.push(argument);
  }
  if (initialPrompt != null) args.push("--", initialPrompt);
  return args;
}

async function trustFolder(sessionFolder: string, env: SpawnEnv): Promise<void> {
  const resolvedSessionFolder = await fs.promises.realpath(sessionFolder).catch(() => sessionFolder);
  const folderTrust = createClaudeFolderTrust({ env });
  await folderTrust.ensureTrusted(resolvedSessionFolder);
  const mainCheckout = await mainCheckoutOf(resolvedSessionFolder);
  if (mainCheckout === null || mainCheckout === resolvedSessionFolder) return;
  await folderTrust.ensureTrusted(mainCheckout);
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
  trustFolder,
  accountHomeProfile: CLAUDE_HOME_PROFILE,
  credentialEnvNames: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN"],
  capabilities: {
    hooks: true,
    awaitingInput: true,
    backgroundAgents: true,
    announcesFinishedBackgroundWork: true,
    resume: true,
    planLimits: true,
    saneYolo: true,
    compactQuiet: true,
    skipPermissionsFlag: true,
    headless: true,
    toolHookContext: true,
    resumeNoteByHook: true,
    drawsOwnAlternateScreen: true,
    permissionHoldOnPromptOnly: true,
  },
  inputReady: "startup-hook",
  promptContextReply: "additional-context",
  isBrailleChar,
  isSpinnerChar,
  isKnownIdleChar,
  mapHookToSignal,
  mapHookConfidence,
  mapHookPromptKind,
  mapHookPromptToolName,
} satisfies AgentAdapterShape;

export default claudeCode;
