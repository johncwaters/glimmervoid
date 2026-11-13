import { MCP_CREDENTIAL_ENV } from "../../mcp/core/agent-config.ts";

const SAFE_LAUNCH_PART_RE = /^[^\0\r\n]+$/;

const PLUGIN_SOURCE = `const RELAY_LAUNCH = __RELAY_LAUNCH__;
const HOOK_URL_ENV = "GLIMMERVOID_HOOK_URL";
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

let relayQueue = Promise.resolve();

async function runRelay(event, payload) {
  const child = Bun.spawn([...RELAY_LAUNCH, event], { stdin: "pipe", stdout: "ignore", stderr: "ignore", windowsHide: true });
  child.stdin.write(JSON.stringify({ hook_event_name: event, ...payload }));
  child.stdin.end();
  await child.exited;
}

function relay(event, payload) {
  if (!process.env[HOOK_URL_ENV]) return;
  relayQueue = relayQueue.then(() => runRelay(event, payload)).catch(() => {});
}

export default {
  id: "glimmervoid",
  setup(ctx) {
    const parentIdBySession = new Map();
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

    async function relayEvent(type, properties) {
      const sessionID = typeof properties?.sessionID === "string" ? properties.sessionID : null;
      const anySessionEvent = ANY_SESSION_EVENT_NAMES[type];
      if (anySessionEvent) {
        const rootId = sessionID ? await rootIdOf(sessionID) : rootSessionId;
        relay(anySessionEvent, rootPayload(rootId, { tool_name: typeof properties?.action === "string" ? properties.action : null }));
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
        rootSessionId = sessionID;
        rootSessionTitle = null;
        relay("SessionStart", rootPayload(sessionID, { source: "startup" }));
        return;
      }
      if (type === "session.renamed") {
        if (typeof properties.title === "string") rootSessionTitle = properties.title;
        return;
      }
      rootSessionId = sessionID;
      relayRootExecutionEvent(type, sessionID);
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
      const wasCompactionOnly = executionPhase === "compacting";
      executionPhase = null;
      if (wasCompactionOnly) return;
      relay(endEvent, rootPayload(sessionID));
    }

    ctx.session.hook("prompt", async (event) => {
      const parentId = await parentIdOf(event.sessionID);
      if (parentId) return;
      rootSessionId = event.sessionID;
      relay("UserPromptSubmit", rootPayload(event.sessionID, { prompt: typeof event.prompt?.text === "string" ? event.prompt.text : "" }));
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

function openCodeConfigContent(operatorConfigText: string | undefined, pluginFolderUrl: string, mcpUrl: string | null): string {
  const operatorConfig = parsedConfigObject(operatorConfigText);
  const plugins = [...arrayField(operatorConfig, "plugins").filter((entry) => entry !== pluginFolderUrl), pluginFolderUrl];
  const config: Record<string, unknown> = { ...operatorConfig, plugins };
  if (mcpUrl) config.mcp = { ...objectField(operatorConfig, "mcp"), glimmervoid: { type: "remote", url: mcpUrl, enabled: true, headers: { Authorization: `Bearer {env:${MCP_CREDENTIAL_ENV}}` } } };
  return JSON.stringify(config);
}

export { openCodeConfigContent, openCodePluginFiles };
