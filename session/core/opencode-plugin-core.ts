import { MCP_CREDENTIAL_ENV } from "../../mcp/core/agent-config.ts";
import { QUESTION_TOOL_HOLD_HOOK_EVENT } from "../../shared/contracts/question-manager.ts";
import { ASK_USER_QUESTION_TOOL_NAME, CONVERSATION_PERMISSION_HOOK_EVENT } from "../../shared/contracts/session.ts";
import { CONVERSATION_EVENTS_HOOK_EVENT } from "../../shared/contracts/trace.ts";

const SAFE_LAUNCH_PART_RE = /^[^\0\r\n]+$/;

const PLUGIN_SOURCE = `const RELAY_LAUNCH = __RELAY_LAUNCH__;
const HOOK_URL_ENV = "GLIMMERVOID_HOOK_URL";
const QUESTION_HOLD_EVENT = "${QUESTION_TOOL_HOLD_HOOK_EVENT}";
const QUESTION_TOOL_NAME = "${ASK_USER_QUESTION_TOOL_NAME}";
const PERMISSION_HOLD_EVENT = "${CONVERSATION_PERMISSION_HOOK_EVENT}";
const PERMISSION_DECISIONS = { allow: "once", deny: "reject" };
const OPENCODE_QUESTION_TOOL = "question";
const SHELL_TOOL_NAME = "Bash";
const BACKGROUND_SHELL_ENVELOPE = /<shell id="([^"]+)" state="([^"]+)"/;
const EXECUTION_END_EVENT_NAMES = {
  "session.execution.succeeded": "Stop",
  "session.execution.failed": "StopFailure",
  "session.execution.interrupted": "Interrupt",
};
const MODEL_ACTIVITY_EVENT_TYPES = new Set(["session.step.started", "session.tool.called"]);
const CHILD_EVENT_NAMES = {
  "session.execution.started": "SubagentStart",
  "session.execution.succeeded": "SubagentStop",
  "session.execution.failed": "SubagentStop",
  "session.execution.interrupted": "SubagentStop",
};
const ANY_SESSION_EVENT_NAMES = {
  "permission.asked": "PermissionRequest",
  "permission.replied": "PermissionResult",
  "form.created": "Elicitation",
  "form.replied": "ElicitationResult",
  "form.cancelled": "ElicitationResult",
};
const FORM_EVENT_TYPES = new Set(["form.created", "form.replied", "form.cancelled"]);
const GLOBAL_FORM_SESSION_ID = "global";
const CONVERSATION_EVENTS_EVENT = "${CONVERSATION_EVENTS_HOOK_EVENT}";
const CONVERSATION_EVENT_TYPES = new Set(["session.inbox.enqueued", "session.reasoning.ended", "session.text.ended", "session.tool.called", "session.tool.success", "session.tool.failed"]);
const CONVERSATION_ITEM_TYPES = new Set(["user", "synthetic"]);
const CONVERSATION_CHUNK_BYTES = 48000;
const CONVERSATION_STRING_CHARS = [12000, 1000];
const utf8 = new TextEncoder();

let relayQueue = Promise.resolve(null);

async function runRelay(event, payload) {
  const child = Bun.spawn([...RELAY_LAUNCH, event], { stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true });
  child.stdin.write(JSON.stringify({ hook_event_name: event, ...payload }));
  child.stdin.end();
  const [output] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return output;
}

function parsedReply(output) {
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function heldRelay(event, payload) {
  if (!process.env[HOOK_URL_ENV]) return { reply: Promise.resolve(null), stop: () => {} };
  const child = Bun.spawn([...RELAY_LAUNCH, event], { stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true });
  child.stdin.write(JSON.stringify({ hook_event_name: event, ...payload }));
  child.stdin.end();
  const reply = Promise.all([new Response(child.stdout).text(), child.exited]).then(([output]) => parsedReply(output), () => null);
  return { reply, stop: () => child.kill() };
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

function cutStrings(value, maxChars) {
  if (typeof value === "string") return value.length > maxChars ? value.slice(0, maxChars) : value;
  if (Array.isArray(value)) return value.map((item) => cutStrings(item, maxChars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cutStrings(item, maxChars)]));
  return value;
}

function jsonBytes(value) {
  return utf8.encode(JSON.stringify(value)).length;
}

function fittedConversationEvent(event) {
  if (jsonBytes(event) <= CONVERSATION_CHUNK_BYTES) return event;
  for (const maxChars of CONVERSATION_STRING_CHARS) {
    const cutEvent = { ...cutStrings(event, maxChars), cut: true };
    if (jsonBytes(cutEvent) <= CONVERSATION_CHUNK_BYTES) return cutEvent;
  }
  return null;
}

function conversationChunks(events) {
  const chunks = [];
  let chunk = [];
  let chunkBytes = 0;
  for (const event of events) {
    const eventBytes = jsonBytes(event);
    if (chunk.length > 0 && chunkBytes + eventBytes > CONVERSATION_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(event);
    chunkBytes += eventBytes + 1;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function taskNotificationPrompt(shellId, state) {
  return "<task-notification>\\n<task-id>" + shellId + "</task-id>\\n<status>" + state + "</status>\\n</task-notification>";
}

export default {
  id: "glimmervoid",
  setup(ctx) {
    const parentIdBySession = new Map();
    const questionInputBySession = new Map();
    const formSessionById = new Map();
    const backgroundShellByCall = new Map();
    const pendingPromptContexts = [];
    const runningBackgroundShellIds = new Set();
    const conversationBySession = new Map();
    const permissionHoldById = new Map();
    let rootSessionId = null;
    let rootSessionTitle = null;
    let executionPhase = null;

    function rootPayload(sessionID, fields = {}) {
      return { session_id: sessionID, ...(rootSessionTitle ? { session_title: rootSessionTitle } : {}), ...fields };
    }

    async function parentIdOf(sessionID) {
      if (parentIdBySession.has(sessionID)) return parentIdBySession.get(sessionID);
      const parentId = await ctx.session.get({ sessionID }).then((session) => session?.parentID ?? null, () => null);
      parentIdBySession.set(sessionID, parentId);
      return parentId;
    }

    async function rootIdOf(sessionID) {
      let currentId = sessionID;
      for (let depth = 0; depth < 16; depth += 1) {
        const parentId = await parentIdOf(currentId);
        if (!parentId) return currentId;
        currentId = parentId;
      }
      return currentId;
    }

    async function payloadFor(sessionID, fields) {
      const rootId = await rootIdOf(sessionID);
      return rootPayload(rootId, { ...fields, ...(rootId === sessionID ? {} : { agent_id: sessionID }) });
    }

    function questionFields(sessionID) {
      const toolInput = questionInputBySession.get(sessionID);
      return toolInput ? { tool_name: QUESTION_TOOL_NAME, tool_input: toolInput } : { tool_name: null };
    }

    function conversationOf(sessionID) {
      if (!conversationBySession.has(sessionID)) conversationBySession.set(sessionID, { events: [], toolNameByCallId: new Map() });
      return conversationBySession.get(sessionID);
    }

    function noteConversationEvent(type, properties, sessionID) {
      if (type === "session.tool.input.started" && typeof properties.id === "string" && typeof properties.name === "string") {
        conversationOf(sessionID).toolNameByCallId.set(properties.id, properties.name);
        return;
      }
      if (!CONVERSATION_EVENT_TYPES.has(type)) return;
      if (type === "session.inbox.enqueued" && !CONVERSATION_ITEM_TYPES.has(properties.item?.type)) return;
      const { native: _native, ...keptProperties } = properties;
      const conversation = conversationOf(sessionID);
      const toolName = type === "session.tool.called" ? conversation.toolNameByCallId.get(properties.id) : undefined;
      const event = fittedConversationEvent({ type, properties: toolName ? { ...keptProperties, name: toolName } : keptProperties });
      if (event) conversation.events.push(event);
    }

    function flushConversation(sessionID) {
      const conversation = conversationBySession.get(sessionID);
      if (!conversation) return;
      conversationBySession.delete(sessionID);
      for (const chunk of conversationChunks(conversation.events)) relay(CONVERSATION_EVENTS_EVENT, rootPayload(sessionID, { events: chunk }));
    }

    async function relayAnySessionEvent(type, properties, sessionID) {
      const eventName = ANY_SESSION_EVENT_NAMES[type];
      const actionFields = { tool_name: typeof properties?.action === "string" ? properties.action : null };
      if (!sessionID) {
        relay(eventName, rootPayload(rootSessionId, actionFields));
        return;
      }
      const fields = FORM_EVENT_TYPES.has(type) ? questionFields(sessionID) : actionFields;
      if (type !== "form.created" && FORM_EVENT_TYPES.has(type)) questionInputBySession.delete(sessionID);
      relay(eventName, await payloadFor(sessionID, fields));
      if (type === "permission.asked") await holdPermissionForChat(properties, sessionID);
      if (type === "permission.replied") stopPermissionHold(properties?.requestID);
    }

    async function holdPermissionForChat(properties, sessionID) {
      const requestID = typeof properties?.id === "string" ? properties.id : null;
      const action = typeof properties?.action === "string" ? properties.action : null;
      if (!requestID || !action) return;
      const toolInput = { resources: Array.isArray(properties.resources) ? properties.resources : [] };
      const hold = heldRelay(PERMISSION_HOLD_EVENT, await payloadFor(sessionID, { tool_name: action, tool_input: toolInput }));
      permissionHoldById.set(requestID, hold);
      void hold.reply.then((reply) => {
        if (permissionHoldById.get(requestID) !== hold) return;
        permissionHoldById.delete(requestID);
        const decision = PERMISSION_DECISIONS[reply?.hookSpecificOutput?.decision?.behavior];
        if (!decision) return;
        const message = reply?.hookSpecificOutput?.decision?.message;
        if (decision === "reject" && typeof message === "string") return ctx.permission.reply({ sessionID, requestID, decision, message });
        return ctx.permission.reply({ sessionID, requestID, decision });
      }).catch(() => {});
    }

    function stopPermissionHold(requestID) {
      const hold = permissionHoldById.get(requestID);
      if (!hold) return;
      permissionHoldById.delete(requestID);
      hold.stop();
    }

    function formSessionIdOf(type, properties) {
      if (type === "form.created") {
        const form = properties?.form;
        const sessionID = typeof form?.sessionID === "string" && form.sessionID !== GLOBAL_FORM_SESSION_ID ? form.sessionID : null;
        if (sessionID && typeof form?.id === "string") formSessionById.set(form.id, sessionID);
        return sessionID;
      }
      const formId = typeof properties?.id === "string" ? properties.id : null;
      const sessionID = formId ? formSessionById.get(formId) ?? null : null;
      if (formId) formSessionById.delete(formId);
      return sessionID;
    }

    function sessionIdOfEvent(type, properties) {
      if (FORM_EVENT_TYPES.has(type)) return formSessionIdOf(type, properties);
      return typeof properties?.sessionID === "string" ? properties.sessionID : null;
    }

    async function relayEvent(type, properties) {
      const sessionID = sessionIdOfEvent(type, properties);
      if (ANY_SESSION_EVENT_NAMES[type]) {
        await relayAnySessionEvent(type, properties, sessionID);
        return;
      }
      if (!sessionID) return;
      const parentId = await parentIdOf(sessionID);
      if (parentId) {
        const childEvent = CHILD_EVENT_NAMES[type];
        if (childEvent) relay(childEvent, { session_id: await rootIdOf(sessionID), agent_id: sessionID });
        return;
      }
      if (type === "session.created") {
        if (rootSessionId) flushConversation(rootSessionId);
        const source = rootSessionId ? "clear" : "startup";
        rootSessionId = sessionID;
        rootSessionTitle = null;
        executionPhase = null;
        runningBackgroundShellIds.clear();
        relay("SessionStart", rootPayload(sessionID, { source }));
        return;
      }
      if (type === "session.renamed") {
        if (typeof properties.title === "string") rootSessionTitle = properties.title;
        return;
      }
      rootSessionId = sessionID;
      noteConversationEvent(type, properties, sessionID);
      relayBackgroundShellEvent(type, properties, sessionID);
      relayRootExecutionEvent(type, sessionID);
    }

    function relayBackgroundShellEvent(type, properties, sessionID) {
      const callId = typeof properties.id === "string" ? properties.id : null;
      if (type === "session.tool.called" && callId && properties.input?.background === true) {
        backgroundShellByCall.set(callId, { toolInput: properties.input, shellId: null });
        return;
      }
      if (type === "session.tool.progress" && callId && backgroundShellByCall.has(callId)) {
        const shellId = properties.metadata?.shellID;
        if (typeof shellId === "string") backgroundShellByCall.get(callId).shellId = shellId;
        return;
      }
      if (type === "session.tool.success" && callId && backgroundShellByCall.has(callId)) {
        const { toolInput, shellId } = backgroundShellByCall.get(callId);
        backgroundShellByCall.delete(callId);
        if (shellId) runningBackgroundShellIds.add(shellId);
        if (shellId) relay("PostToolUse", rootPayload(sessionID, { tool_name: SHELL_TOOL_NAME, tool_input: toolInput, tool_response: { backgroundTaskId: shellId } }));
        return;
      }
      if (type === "session.tool.failed" && callId) {
        backgroundShellByCall.delete(callId);
        return;
      }
      if (type !== "session.inbox.enqueued" || properties.item?.type !== "synthetic") return;
      const envelope = BACKGROUND_SHELL_ENVELOPE.exec(String(properties.item?.payload?.text ?? ""));
      if (!envelope) return;
      runningBackgroundShellIds.delete(envelope[1]);
      void relayForReply("UserPromptSubmit", rootPayload(sessionID, { prompt: taskNotificationPrompt(envelope[1], envelope[2]) })).then((reply) => {
        const context = replyContext(reply);
        if (context) pendingPromptContexts.push(context);
      });
    }

    function relayRootExecutionEvent(type, sessionID) {
      if (type === "session.execution.started") {
        executionPhase = "pending";
        return;
      }
      if (MODEL_ACTIVITY_EVENT_TYPES.has(type)) {
        if (executionPhase !== "pending" && executionPhase !== "compacting") return;
        executionPhase = "running";
        relay("TurnStart", rootPayload(sessionID));
        return;
      }
      if (type === "session.compaction.started") {
        if (executionPhase === "pending") executionPhase = "compacting";
        relay("PreCompact", rootPayload(sessionID));
        return;
      }
      if (type === "session.compaction.ended" || type === "session.compaction.failed") {
        relay("PostCompact", rootPayload(sessionID));
        return;
      }
      const endEvent = EXECUTION_END_EVENT_NAMES[type];
      if (!endEvent) return;
      flushConversation(sessionID);
      const wasCompactionOnly = executionPhase === "compacting";
      executionPhase = null;
      if (wasCompactionOnly) return;
      relay(endEvent, rootPayload(sessionID, { background_tasks: [...runningBackgroundShellIds].map((shellId) => ({ id: shellId, type: "shell", status: "running" })) }));
    }

    ctx.session.hook("prompt", async (event) => {
      const parentId = await parentIdOf(event.sessionID);
      if (parentId) return;
      rootSessionId = event.sessionID;
      const promptText = typeof event.prompt?.text === "string" ? event.prompt.text : "";
      const replyContextText = replyContext(await relayForReply("UserPromptSubmit", rootPayload(event.sessionID, { prompt: promptText })));
      const contexts = [...pendingPromptContexts.splice(0), ...(replyContextText ? [replyContextText] : [])];
      if (contexts.length === 0 || !event.prompt) return;
      const context = contexts.join("\\n\\n");
      event.prompt.text = promptText ? promptText + "\\n\\n" + context : context;
    });

    ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== OPENCODE_QUESTION_TOOL) return;
      const toolInput = event.input && typeof event.input === "object" ? event.input : {};
      questionInputBySession.set(event.sessionID, toolInput);
      const reason = denialReason(await relayForReply(QUESTION_HOLD_EVENT, await payloadFor(event.sessionID, { tool_name: QUESTION_TOOL_NAME, tool_input: toolInput })));
      if (!reason) return;
      questionInputBySession.delete(event.sessionID);
      throw new Error(reason);
    });

    const subscription = new AbortController();
    (async () => {
      for await (const event of ctx.event.subscribe({ signal: subscription.signal })) {
        await relayEvent(event.type, event.properties ?? event.data ?? {}).catch(() => {});
      }
    })().catch(() => {});
    return () => subscription.abort();
  },
};
`;

function renderOpenCodePlugin(relayLaunch: readonly string[]): string | null {
  if (relayLaunch.length === 0 || !relayLaunch.every((part) => SAFE_LAUNCH_PART_RE.test(part))) return null;
  return PLUGIN_SOURCE.replace("__RELAY_LAUNCH__", JSON.stringify(relayLaunch));
}

const PLUGIN_PACKAGE_JSON = `${JSON.stringify({ name: "glimmervoid-opencode-plugin", private: true, type: "module", main: "index.js" }, null, 2)}\n`;

function openCodePluginFiles(relayLaunch: readonly string[]): Record<string, string> | null {
  const plugin = renderOpenCodePlugin(relayLaunch);
  if (plugin === null) return null;
  return { "package.json": PLUGIN_PACKAGE_JSON, "index.js": plugin };
}

function parsedConfigObject(configText: string | undefined): Record<string, unknown> {
  if (!configText) return {};
  try {
    const parsed: unknown = JSON.parse(configText);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

function objectField(config: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = config[field];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
}

function arrayField(config: Record<string, unknown>, field: string): unknown[] {
  const value = config[field];
  return Array.isArray(value) ? value : [];
}

interface OpenCodeLaunchConfig {
  pluginFolderUrl: string;
  mcpUrl: string | null;
  skillFolders: readonly string[];
  model: string | null;
}

function openCodeConfigContent(operatorConfigText: string | undefined, { pluginFolderUrl, mcpUrl, skillFolders, model }: OpenCodeLaunchConfig): string {
  const operatorConfig = parsedConfigObject(operatorConfigText);
  const plugins = [...arrayField(operatorConfig, "plugins").filter((entry) => entry !== pluginFolderUrl), pluginFolderUrl];
  const config: Record<string, unknown> = { ...operatorConfig, plugins };
  if (mcpUrl) config.mcp = { ...objectField(operatorConfig, "mcp"), glimmervoid: { type: "remote", url: mcpUrl, enabled: true, headers: { Authorization: `Bearer {env:${MCP_CREDENTIAL_ENV}}` } } };
  if (skillFolders.length > 0) config.skills = [...arrayField(operatorConfig, "skills").filter((entry) => typeof entry !== "string" || !skillFolders.includes(entry)), ...skillFolders];
  if (model) config.model = model;
  return JSON.stringify(config);
}

export { openCodeConfigContent, openCodePluginFiles };
