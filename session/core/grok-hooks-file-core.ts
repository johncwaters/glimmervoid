import { isRecord } from "../../shared/coerce.ts";
import { buildHookCommand } from "./hook-command-core.ts";

interface HookHandler {
  type: string;
  command: string;
}

interface HookMatcherGroup {
  hooks: HookHandler[];
}

type GrokHooksClassification = "absent" | "current" | "foreign" | "managed-stale";

interface GrokHooksFileOptions {
  relayLaunch: readonly string[];
  events: string[];
  managedEventSets?: string[][];
  hookToolRelayLaunch?: readonly string[];
}

function hookGroup(command: string): HookMatcherGroup[] {
  return [{ hooks: [{ type: "command", command }] }];
}

function renderGrokHooksFile({ relayLaunch, events, hookToolRelayLaunch }: GrokHooksFileOptions): string | null {
  const hooks: Record<string, HookMatcherGroup[]> = {};
  for (const event of events) {
    const command = buildHookCommand(relayLaunch, event);
    if (!command) return null;
    hooks[event] = hookGroup(command);
  }
  if (hookToolRelayLaunch) {
    const command = buildHookCommand(hookToolRelayLaunch, "saneYolo");
    if (!command) return null;
    hooks.PreToolUse = hookGroup(command);
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

function hasOnlyKeys(value: unknown, expectedKeys: string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === sortedExpectedKeys.length
    && actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

const MANAGED_RELAY_RE = /(?:^|\/)(hook-relay|hook-tool-relay)\.(?:js|mjs|ts)$/;
const NODE_RELAY_COMMAND_RE = /^node (?:(?:"([^"\r\n]+)")|([^\s"']+)) ([A-Za-z][A-Za-z0-9_-]{0,63})$/;
const BINARY_RELAY_COMMAND_RE = /^(?:(?:"([^"\r\n]+)")|([^\s"']+)) __run (hook-relay|hook-tool-relay) ([A-Za-z][A-Za-z0-9_-]{0,63})$/;

interface ManagedRelayCommand {
  launch: string[];
  relayName: string;
  token: string;
}

function parseManagedRelayCommand(command: string): ManagedRelayCommand | null {
  const nodeMatch = command.match(NODE_RELAY_COMMAND_RE);
  if (nodeMatch) {
    const relayScript = nodeMatch[1] || nodeMatch[2];
    const relayName = relayScript.match(MANAGED_RELAY_RE)?.[1];
    if (!relayName) return null;
    return { launch: ["node", relayScript], relayName, token: nodeMatch[3] };
  }
  const binaryMatch = command.match(BINARY_RELAY_COMMAND_RE);
  if (!binaryMatch) return null;
  return { launch: [binaryMatch[1] || binaryMatch[2], "__run", binaryMatch[3]], relayName: binaryMatch[3], token: binaryMatch[4] };
}

function isManagedCommand(command: unknown, event: string): boolean {
  if (typeof command !== "string") return false;
  const relayCommand = parseManagedRelayCommand(command);
  if (!relayCommand) return false;
  const expectedRelay = event === "PreToolUse" ? "hook-tool-relay" : "hook-relay";
  const expectedToken = event === "PreToolUse" ? "saneYolo" : event;
  if (relayCommand.relayName !== expectedRelay || relayCommand.token !== expectedToken) return false;
  return buildHookCommand(relayCommand.launch, expectedToken) === command;
}

function isManagedHookGroup(group: unknown, event: string): boolean {
  if (!Array.isArray(group) || group.length !== 1) return false;
  const matcherGroup: unknown = group[0];
  if (!hasOnlyKeys(matcherGroup, ["hooks"])) return false;
  if (!Array.isArray(matcherGroup.hooks) || matcherGroup.hooks.length !== 1) return false;
  const handler: unknown = matcherGroup.hooks[0];
  if (!hasOnlyKeys(handler, ["type", "command"])) return false;
  if (handler.type !== "command") return false;
  return isManagedCommand(handler.command, event);
}

function classifyGrokHooksFile(
  contents: string | null | undefined,
  { relayLaunch, events, managedEventSets = [], hookToolRelayLaunch }: GrokHooksFileOptions,
): GrokHooksClassification {
  if (contents == null) return "absent";
  const expected = renderGrokHooksFile({ relayLaunch, events, hookToolRelayLaunch });
  if (contents === expected) return "current";
  if (contents === renderGrokHooksFile({ relayLaunch, events })) return "current";
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return "foreign";
  }
  if (!hasOnlyKeys(parsed, ["hooks"])) return "foreign";
  const hooksValue = parsed.hooks;
  if (hooksValue === null || hooksValue === undefined) throw new TypeError("hooks must be an object");
  if (!isRecord(hooksValue)) return "foreign";
  const actualEvents = Object.keys(hooksValue);
  if (!hasOnlyKeys(hooksValue, actualEvents)) return "foreign";
  const hooks = hooksValue;
  const eventSets = [events, ...managedEventSets];
  const hasManagedEventSet = eventSets.some((managedEvents) => hasOnlyKeys(hooks, managedEvents)
    || hasOnlyKeys(hooks, [...managedEvents, "PreToolUse"]));
  if (!hasManagedEventSet) return "foreign";
  for (const event of actualEvents) {
    if (!isManagedHookGroup(hooks[event], event)) return "foreign";
  }
  return "managed-stale";
}

export { renderGrokHooksFile, classifyGrokHooksFile };
