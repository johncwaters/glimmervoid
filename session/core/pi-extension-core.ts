import { MCP_CREDENTIAL_ENV } from "../../mcp/core/agent-config.ts";
import { QUESTION_TOOL_HOLD_HOOK_EVENT } from "../../shared/contracts/question-manager.ts";
import { ASK_USER_QUESTION_TOOL_NAME } from "../../shared/contracts/session.ts";

const SAFE_LAUNCH_PART_RE = /^[^\0\r\n]+$/;
const PI_LAUNCH_ENV_NAME = "GLIMMERVOID_PI_LAUNCH";
const PI_SKIP_PERMISSIONS_FLAG = "glimmervoid-skip-permissions";

const EXTENSION_SOURCE = `const RELAY_LAUNCH = __RELAY_LAUNCH__;
const HOOK_URL_ENV = "GLIMMERVOID_HOOK_URL";
const LAUNCH_ENV = "${PI_LAUNCH_ENV_NAME}";
const MCP_CREDENTIAL_ENV = "${MCP_CREDENTIAL_ENV}";
const SKIP_PERMISSIONS_FLAG = "${PI_SKIP_PERMISSIONS_FLAG}";
const QUESTION_HOLD_EVENT = "${QUESTION_TOOL_HOLD_HOOK_EVENT}";
const QUESTION_TOOL_NAME = "${ASK_USER_QUESTION_TOOL_NAME}";
const GATED_TOOL_NAMES = { bash: "Bash", powershell: "PowerShell", write: "Write", edit: "Edit" };
const RELAYED_TOOL_INPUT_MAX_CHARACTERS = 16000;
const SESSION_START_SOURCES = { new: "clear" };
const READ_ONLY_COMMAND = /^(?:git branch|(?:ls|pwd|cat|head|tail|wc|stat|which|git (?:status|diff|log|show|rev-parse))(?: (?!--output)[\\w./:@,+-]+)*)$/;
const OWN_ANSWER_CHOICE = "Type my own answer";
const QUESTION_PARAMETERS = {
  type: "object",
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        required: ["question", "options"],
        properties: {
          question: { type: "string" },
          header: { type: "string" },
          multiSelect: { type: "boolean" },
          options: { type: "array", items: { type: "object", required: ["label"], properties: { label: { type: "string" }, description: { type: "string" } } } },
        },
      },
    },
  },
};
const { spawn } = process.getBuiltinModule("node:child_process");

let relayQueue = Promise.resolve(null);

function runRelay(event, payload) {
  return new Promise((resolve) => {
    const child = spawn(RELAY_LAUNCH[0], [...RELAY_LAUNCH.slice(1), event], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(output));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ hook_event_name: event, ...payload }));
  });
}

function parsedReply(output) {
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function relayForReply(event, payload) {
  if (!process.env[HOOK_URL_ENV]) return Promise.resolve(null);
  relayQueue = relayQueue.then(() => runRelay(event, payload)).then(parsedReply, () => null);
  return relayQueue;
}

function relay(event, payload) {
  void relayForReply(event, payload);
}

function replyContext(reply) {
  if (typeof reply?.message === "string") return reply.message;
  const additionalContext = reply?.hookSpecificOutput?.additionalContext;
  return typeof additionalContext === "string" ? additionalContext : null;
}

function denialReason(reply) {
  const output = reply?.hookSpecificOutput;
  return output?.permissionDecision === "deny" && typeof output.permissionDecisionReason === "string" ? output.permissionDecisionReason : null;
}

function launchConfig() {
  try {
    const parsed = JSON.parse(process.env[LAUNCH_ENV] ?? "{}");
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function textOf(text) {
  return { content: [{ type: "text", text }], details: {} };
}

function isReadOnlyCommand(toolName, input) {
  return toolName === "bash" && READ_ONLY_COMMAND.test(String(input?.command ?? "").trim());
}

function relayedToolInput(input) {
  if (JSON.stringify(input ?? null).length <= RELAYED_TOOL_INPUT_MAX_CHARACTERS) return input;
  return { path: input?.path, command: String(input?.command ?? "").slice(0, RELAYED_TOOL_INPUT_MAX_CHARACTERS), truncated: true };
}

function permissionSummary(toolName, input) {
  if (toolName === "bash" || toolName === "powershell") return String(input?.command ?? "");
  return String(input?.path ?? input?.file_path ?? "");
}

export default function (pi) {
  const launch = launchConfig();
  const skillPaths = Array.isArray(launch.skillPaths) ? launch.skillPaths.filter((entry) => typeof entry === "string") : [];
  const pendingPromptContexts = [];
  let sessionId = null;
  const openPhases = new Set();

  pi.registerFlag(SKIP_PERMISSIONS_FLAG, { description: "Run bash, write and edit without asking", type: "boolean", default: false });

  if (typeof launch.mcpUrl === "string" && process.env[MCP_CREDENTIAL_ENV]) {
    pi.registerMcpServer("glimmervoid", { url: launch.mcpUrl, exposure: "direct", headers: { Authorization: "Bearer " + process.env[MCP_CREDENTIAL_ENV] } });
  }

  function payload(fields = {}) {
    const sessionTitle = pi.getSessionName();
    return { session_id: sessionId, ...(sessionTitle ? { session_title: sessionTitle } : {}), ...fields };
  }

  function rememberSession(ctx) {
    sessionId = ctx.sessionManager.getSessionId() ?? sessionId;
  }

  pi.on("session_start", async (event, ctx) => {
    rememberSession(ctx);
    openPhases.delete("turn");
    const context = replyContext(await relayForReply("SessionStart", payload({ source: SESSION_START_SOURCES[event.reason] ?? event.reason })));
    if (context) pendingPromptContexts.push(context);
  });

  pi.on("resources_discover", async () => (skillPaths.length > 0 ? { skillPaths } : {}));

  pi.on("input", async (event, ctx) => {
    rememberSession(ctx);
    if (event.source === "extension") return { action: "continue" };
    const context = replyContext(await relayForReply("UserPromptSubmit", payload({ prompt: event.text })));
    const contexts = [...pendingPromptContexts.splice(0), ...(context ? [context] : [])];
    if (contexts.length === 0) return { action: "continue" };
    const joined = contexts.join("\\n\\n");
    return { action: "transform", text: event.text ? event.text + "\\n\\n" + joined : joined };
  });

  pi.on("agent_start", async (_event, ctx) => {
    rememberSession(ctx);
    if (openPhases.has("turn")) return;
    openPhases.add("turn");
    relay("TurnStart", payload());
  });

  pi.on("agent_settled", async (event) => {
    openPhases.delete("turn");
    relay(event.aborted ? "Interrupt" : "Stop", payload());
  });

  pi.on("ui_prompt_start", async (event) => {
    if (openPhases.has("ownPrompt")) return;
    relay("Elicitation", payload({ title: event.title ?? null }));
  });

  pi.on("ui_prompt_end", async () => {
    if (openPhases.has("ownPrompt")) return;
    relay("ElicitationResult", payload());
  });

  pi.on("session_before_compact", async () => {
    openPhases.add("compaction");
    relay("PreCompact", payload());
  });

  function endCompaction() {
    if (!openPhases.delete("compaction")) return;
    relay("PostCompact", payload());
  }

  pi.on("session_compact", async () => endCompaction());

  pi.on("session_compact_failed", async () => endCompaction());

  pi.on("tool_call", async (event, ctx) => {
    const gatedToolName = GATED_TOOL_NAMES[event.toolName];
    if (!gatedToolName || pi.getFlag(SKIP_PERMISSIONS_FLAG) || isReadOnlyCommand(event.toolName, event.input)) return;
    if (!ctx.hasUI) return { block: true, reason: "Glimmervoid asks before " + event.toolName + " runs, and this pi run has no prompt to ask in." };
    const toolPayload = payload({ tool_name: gatedToolName, tool_input: relayedToolInput(event.input) });
    relay("PermissionRequest", toolPayload);
    openPhases.add("ownPrompt");
    const isAllowed = await ctx.ui.confirm("Allow " + event.toolName + "?", permissionSummary(event.toolName, event.input)).finally(() => {
      openPhases.delete("ownPrompt");
    });
    relay("PermissionResult", toolPayload);
    if (isAllowed) return;
    return { block: true, reason: "The operator denied this " + event.toolName + " call." };
  });

  pi.registerTool({
    name: "ask_user_question",
    label: "Ask the operator",
    description: "Ask the operator one or more multiple-choice questions and wait for the answers.",
    promptSnippet: "Ask the operator multiple-choice questions when a decision is theirs to make",
    promptGuidelines: ["Use ask_user_question when you need the operator to choose between options before continuing."],
    parameters: QUESTION_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      rememberSession(ctx);
      const heldAnswer = denialReason(await relayForReply(QUESTION_HOLD_EVENT, payload({ tool_name: QUESTION_TOOL_NAME, tool_input: params })));
      if (heldAnswer) return textOf(heldAnswer);
      if (!ctx.hasUI) return textOf("The operator cannot answer questions in this pi run.");
      const questionPayload = payload({ tool_name: QUESTION_TOOL_NAME, tool_input: params });
      relay("Elicitation", questionPayload);
      openPhases.add("ownPrompt");
      const reply = await askEachQuestion(params.questions, ctx).finally(() => {
        openPhases.delete("ownPrompt");
      });
      relay("ElicitationResult", questionPayload);
      return textOf(reply);
    },
  });
}

async function askEachQuestion(questions, ctx) {
  const answers = [];
  for (const question of questions) {
    const labels = question.options.map((option) => option.label);
    const choice = await ctx.ui.select(question.question, [...labels, OWN_ANSWER_CHOICE]);
    if (choice === undefined) return "The operator dismissed the question.";
    const answer = choice === OWN_ANSWER_CHOICE ? await ctx.ui.input(question.question) : choice;
    if (answer === undefined) return "The operator dismissed the question.";
    answers.push('"' + question.question + '"="' + answer + '"');
  }
  return "The operator answered: " + answers.join(", ");
}
`;

function renderPiExtension(relayLaunch: readonly string[]): string | null {
  if (relayLaunch.length === 0 || !relayLaunch.every((part) => SAFE_LAUNCH_PART_RE.test(part))) return null;
  return EXTENSION_SOURCE.replace("__RELAY_LAUNCH__", JSON.stringify(relayLaunch));
}

interface PiLaunchConfig {
  mcpUrl: string | null;
  skillPaths: readonly string[];
}

function piLaunchConfigContent({ mcpUrl, skillPaths }: PiLaunchConfig): string {
  return JSON.stringify({ ...(mcpUrl ? { mcpUrl } : {}), skillPaths });
}

export { PI_LAUNCH_ENV_NAME, PI_SKIP_PERMISSIONS_FLAG, piLaunchConfigContent, renderPiExtension };
