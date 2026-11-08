import { loadJsonStateFileSync, loadedJsonValue, writeJsonAtomicSync } from '../server/json-file.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { hostScratchRoot } from '../server/host-scratch.ts';
import { hookLaunch } from '../server/runtime-paths.ts';
import { shellLaunchText, shellQuote } from '../session/core/hook-command-core.ts';
import { HOOK_TOOLS } from '../session/core/hook-tools.ts';
import type { ResolvedHookTool } from '../session/core/hook-tools.ts';
import { appendUserHooks } from '../session/core/user-hooks-core.ts';
import type { InstalledHookFlags, InstalledHooks, UserHook } from '../session/core/user-hooks-core.ts';
import { PLAN_HOOK_EVENT, PLAN_RESULT_HOOK_EVENT, PLAN_TOOL_NAME } from '../shared/contracts/plan-review.ts';
import { ASK_USER_QUESTION_TOOL_NAME, CONVERSATION_PERMISSION_HOOK_EVENT, CONVERSATION_TOOL_RESULT_HOOK_EVENT } from '../shared/contracts/session.ts';
import { safePathSegment } from '../shared/paths.ts';
import { isRecord, textOr } from '../shared/coerce.ts';

const DEFAULT_BASE_DIR = path.join(hostScratchRoot(), 'glimmervoid-hooks');
const DEFAULT_TIMEOUT_SEC = 5;
const PLAN_HOOK_TIMEOUT_SEC = 86400;
const PLAN_HOLD_RELEASE_LEAD_SEC = 60;
const PLAN_HOLD_RELEASE_MS = (PLAN_HOOK_TIMEOUT_SEC - PLAN_HOLD_RELEASE_LEAD_SEC) * 1000;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

interface SettingsHookHandler {
  type: string;
  url?: string;
  command?: string;
  timeout?: number;
}

interface SettingsHookEntry {
  matcher?: string;
  hooks: SettingsHookHandler[];
}

interface SessionPermissions {
  allow?: string[];
  deny?: string[];
  ask?: string[];
  defaultMode?: string;
}

interface HookSettings {
  hooks: Record<string, SettingsHookEntry[]>;
  permissions?: SessionPermissions;
  enableAllProjectMcpServers?: boolean;
  statusLine?: { type: string; command: string };
  awaySummaryEnabled?: boolean;
  sandbox?: unknown;
  env?: unknown;
  apiKeyHelper?: unknown;
}

interface BuildHookSettingsOptions {
  port: number;
  glimmervoidId: string;
  token: string;
  timeoutSec?: number;
  permissions?: SessionPermissions | null;
  detectScheduledWakeups?: boolean;
  observeToolCalls?: boolean;
  enableProjectMcp?: boolean;
  hookTools?: ResolvedHookTool[];
  planLimits?: boolean;
  planReview?: boolean;
  userSettingsPath?: string | null;
  carryOperatorGuardrails?: boolean;
  relayLaunch?: readonly string[];
  commandHookRelayLaunch?: readonly string[];
  userHooks?: UserHook[];
  remoteNodePath?: string | null;
}

interface WriteSessionSettingsOptions extends Omit<BuildHookSettingsOptions, 'token'> {
  token?: string;
  baseDir?: string;
}

function ensureOwnedDir(dir: string, mode: number): void {
  fs.mkdirSync(dir, { recursive: true, mode });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new Error(`refusing to write hook settings: ${dir} is not a directory`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`refusing to write hook settings: ${dir} is owned by another user`);
  }
  try {
    fs.chmodSync(dir, mode);
  } catch {
  }
}

const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'TeammateIdle', 'PreCompact', 'PostCompact'];

const WAKEUP_TOOL_MATCHER = 'ScheduleWakeup|CronCreate|CronDelete';
const PLAN_TOOL_MATCHER = PLAN_TOOL_NAME;
const PR_LINK_TOOL_MATCHER = 'Bash';
const COMMAND_HINT_TOOL_MATCHER = 'Write|Edit|Agent|Task';
const FAILED_SHELL_TOOL_MATCHER = 'Bash';

const RELAY_LAUNCH = hookLaunch('statusline-relay');
const COMMAND_HOOK_RELAY_LAUNCH = hookLaunch('command-hook-relay');
const NO_CHAIN = '-';

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function toForwardSlashes(value: string): string {
  return String(value).replace(/\\/g, '/');
}

interface OperatorGuardrails {
  denyRules: string[];
  askRules: string[];
  carried: Pick<HookSettings, 'sandbox' | 'env' | 'apiKeyHelper'>;
}

interface OperatorClaudeSettings {
  statuslineCommand: string | null;
  awaySummaryEnabled: boolean | null;
  guardrails: OperatorGuardrails;
}

const CARRIED_GUARDRAIL_KEYS = ['sandbox', 'env', 'apiKeyHelper'] as const;
const NO_OPERATOR_GUARDRAILS: OperatorGuardrails = { denyRules: [], askRules: [], carried: {} };
const NO_OPERATOR_SETTINGS: OperatorClaudeSettings = { statuslineCommand: null, awaySummaryEnabled: null, guardrails: NO_OPERATOR_GUARDRAILS };

function ruleListOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((rule): rule is string => typeof rule === 'string') : [];
}

function guardrailsFrom(parsed: Record<string, unknown>): OperatorGuardrails {
  const permissions = isRecord(parsed.permissions) ? parsed.permissions : {};
  const carried: OperatorGuardrails['carried'] = {};
  for (const key of CARRIED_GUARDRAIL_KEYS) {
    if (parsed[key] !== undefined) carried[key] = parsed[key];
  }
  return { denyRules: ruleListOf(permissions.deny), askRules: ruleListOf(permissions.ask), carried };
}

function statuslineCommandFrom(parsed: Record<string, unknown>): string | null {
  if (!isRecord(parsed.statusLine) || parsed.statusLine.type !== 'command') return null;
  return textOr(parsed.statusLine.command, null);
}

function readOperatorClaudeSettings(settingsPath: string): OperatorClaudeSettings {
  return loadedJsonValue(loadJsonStateFileSync({
    filePath: settingsPath,
    quarantine: false,
    parse(parsed) {
      if (!isRecord(parsed)) return null;
      return {
        statuslineCommand: statuslineCommandFrom(parsed),
        awaySummaryEnabled: typeof parsed.awaySummaryEnabled === 'boolean' ? parsed.awaySummaryEnabled : null,
        guardrails: guardrailsFrom(parsed),
      };
    },
  })) ?? NO_OPERATOR_SETTINGS;
}

function buildStatuslineCommand(
  { relayLaunch = RELAY_LAUNCH, postUrl, userCommand = null }:
    { relayLaunch?: readonly string[]; postUrl: string; userCommand?: string | null },
): string {
  const encoded = userCommand ? Buffer.from(userCommand, 'utf8').toString('base64') : NO_CHAIN;
  return `${shellLaunchText(relayLaunch)} ${shellQuote(postUrl)} ${shellQuote(encoded)}`;
}

function buildCommandHookCommand(
  { relayLaunch = COMMAND_HOOK_RELAY_LAUNCH, postUrl }: { relayLaunch?: readonly string[]; postUrl: string },
): string {
  return `${shellLaunchText(relayLaunch)} ${shellQuote(postUrl)}`;
}

function buildRemoteCommandHookCommand({ nodePath, postUrl }: { nodePath: string; postUrl: string }): string {
  const inlineRelay = 'let body="";process.stdin.setEncoding("utf8").on("data",(chunk)=>{body+=chunk}).on("end",()=>{'
    + 'fetch(process.argv[1],{method:"POST",headers:{"content-type":"application/json"},body,signal:AbortSignal.timeout(4000)})'
    + '.then((response)=>response.ok?response.text():"").then((text)=>{if(text)process.stdout.write(text)}).catch(()=>{})})';
  return `${shellQuote(nodePath)} -e ${shellQuote(inlineRelay)} ${shellQuote(postUrl)}`;
}

function buildHookSettings({ port, glimmervoidId, token, timeoutSec = DEFAULT_TIMEOUT_SEC, permissions = null, detectScheduledWakeups = true, observeToolCalls = false, enableProjectMcp = false, hookTools = [], planLimits = false, planReview = false, userSettingsPath = null, carryOperatorGuardrails, relayLaunch = RELAY_LAUNCH, commandHookRelayLaunch = COMMAND_HOOK_RELAY_LAUNCH, userHooks = [], remoteNodePath = null }: BuildHookSettingsOptions): HookSettings {
  if (!port || !glimmervoidId || !token) {
    throw new Error('buildHookSettings requires port, glimmervoidId, token');
  }
  const base = `http://127.0.0.1:${port}/hook/${encodeURIComponent(glimmervoidId)}`;
  const hookUrl = (event: string) => `${base}/${event.toLowerCase()}?t=${encodeURIComponent(token)}`;
  const hooks: Record<string, SettingsHookEntry[]> = {
    SessionStart: [{ hooks: [{
      type: 'command',
      command: remoteNodePath === null
        ? buildCommandHookCommand({ relayLaunch: commandHookRelayLaunch, postUrl: hookUrl('SessionStart') })
        : buildRemoteCommandHookCommand({ nodePath: remoteNodePath, postUrl: hookUrl('SessionStart') }),
      timeout: timeoutSec,
    }] }],
  };
  for (const event of HOOK_EVENTS) {
    if (event === 'SessionStart') continue;
    hooks[event] = [{ hooks: [{ type: 'http', url: hookUrl(event), timeout: timeoutSec }] }];
  }
  const permissionRequestEntries = hooks.PermissionRequest;
  if (planReview && permissionRequestEntries) {
    permissionRequestEntries.push({
      matcher: PLAN_TOOL_MATCHER,
      hooks: [{ type: 'http', url: hookUrl(PLAN_HOOK_EVENT), timeout: PLAN_HOOK_TIMEOUT_SEC }],
    });
  }
  if (permissionRequestEntries) {
    permissionRequestEntries.push({
      matcher: ASK_USER_QUESTION_TOOL_NAME,
      hooks: [{ type: 'http', url: hookUrl(CONVERSATION_PERMISSION_HOOK_EVENT), timeout: PLAN_HOOK_TIMEOUT_SEC }],
    });
  }
  const sharedPostToolUseMatchers: string[] = [];
  if (detectScheduledWakeups) sharedPostToolUseMatchers.push(WAKEUP_TOOL_MATCHER);
  sharedPostToolUseMatchers.push(PR_LINK_TOOL_MATCHER, ASK_USER_QUESTION_TOOL_NAME, COMMAND_HINT_TOOL_MATCHER);
  const sharedPostToolUseUrl = hookUrl('PostToolUse');
  const postToolUse: SettingsHookEntry[] = sharedPostToolUseMatchers
    .map((matcher) => ({ matcher, hooks: [{ type: 'http', url: sharedPostToolUseUrl, timeout: timeoutSec }] }));
  if (planReview) {
    postToolUse.push({
      matcher: PLAN_TOOL_MATCHER,
      hooks: [{ type: 'http', url: hookUrl(PLAN_RESULT_HOOK_EVENT), timeout: timeoutSec }],
    });
  }
  postToolUse.push({
    matcher: ASK_USER_QUESTION_TOOL_NAME,
    hooks: [{ type: 'http', url: hookUrl(CONVERSATION_TOOL_RESULT_HOOK_EVENT), timeout: timeoutSec }],
  });
  if (postToolUse.length > 0) {
    hooks.PostToolUse = postToolUse;
  }
  hooks.PostToolUseFailure = [{ matcher: FAILED_SHELL_TOOL_MATCHER, hooks: [{ type: 'http', url: hookUrl('PostToolUseFailure'), timeout: timeoutSec }] }];
  const preToolUse: SettingsHookEntry[] = [];
  if (observeToolCalls) {
    preToolUse.push({ hooks: [{ type: 'http', url: hookUrl('PreToolUse'), timeout: timeoutSec }] });
  }
  for (const tool of hookTools) preToolUse.push(HOOK_TOOLS[tool.id].claudeEntry(tool));
  if (preToolUse.length > 0) {
    hooks.PreToolUse = preToolUse;
  }
  appendUserHooks(hooks, Array.isArray(userHooks) ? userHooks : []);
  const operatorSettingsPath = userSettingsPath || path.join(os.homedir(), '.claude', 'settings.json');
  const operatorSettings = readOperatorClaudeSettings(operatorSettingsPath);
  const guardrails = carryOperatorGuardrails ? operatorSettings.guardrails : NO_OPERATOR_GUARDRAILS;
  const settings: HookSettings = { hooks, ...guardrails.carried };
  const allowRules = permissions && Array.isArray(permissions.allow) ? permissions.allow.slice() : [];
  const denyRules = [...(permissions && Array.isArray(permissions.deny) ? permissions.deny : []), ...guardrails.denyRules];
  const askRules = guardrails.askRules;
  const defaultMode = permissions && typeof permissions.defaultMode === 'string' ? permissions.defaultMode : null;
  if (allowRules.length > 0 || denyRules.length > 0 || askRules.length > 0 || defaultMode) {
    settings.permissions = {};
    if (allowRules.length > 0) settings.permissions.allow = allowRules;
    if (denyRules.length > 0) settings.permissions.deny = denyRules;
    if (askRules.length > 0) settings.permissions.ask = askRules;
    if (defaultMode) settings.permissions.defaultMode = defaultMode;
  }
  if (enableProjectMcp) {
    settings.enableAllProjectMcpServers = true;
  }
  if (operatorSettings.awaySummaryEnabled !== null) {
    settings.awaySummaryEnabled = operatorSettings.awaySummaryEnabled;
  }
  if (planLimits) {
    settings.statusLine = {
      type: 'command',
      command: buildStatuslineCommand({
        relayLaunch,
        postUrl: `${base}/statusline?t=${encodeURIComponent(token)}`,
        userCommand: operatorSettings.statuslineCommand,
      }),
    };
  }
  return settings;
}

const DESCRIBE_SESSION_ID = 'describe';
const HOOK_ROUTE_RE = /\/hook\/describe\/([a-z-]+)/;

function routeOf(handler: SettingsHookHandler, hookTools: readonly ResolvedHookTool[]): string | null {
  const target = handler.url ?? handler.command ?? '';
  const endpoint = HOOK_ROUTE_RE.exec(target)?.[1];
  if (endpoint !== undefined) return endpoint;
  return hookTools.find((tool) => target.includes(toForwardSlashes(tool.binPath)))?.id ?? null;
}

function describeInstalledClaudeHooks(flags: InstalledHookFlags): InstalledHooks {
  const settings = buildHookSettings({ port: 1, glimmervoidId: DESCRIBE_SESSION_ID, token: DESCRIBE_SESSION_ID, ...flags });
  const hooks = Object.entries(settings.hooks).flatMap(([event, entries]) => entries.flatMap((entry) => entry.hooks.map((handler) => ({
    event,
    matcher: entry.matcher ?? null,
    route: routeOf(handler, flags.hookTools),
  }))));
  return { version: null, isBestEffort: false, hooks };
}

function writeSessionSettings({ glimmervoidId, token, baseDir = DEFAULT_BASE_DIR, ...rest }: WriteSessionSettingsOptions) {
  const tok = token || generateToken();
  const dir = path.join(baseDir, safePathSegment(glimmervoidId));
  ensureOwnedDir(baseDir, DIR_MODE);
  ensureOwnedDir(dir, DIR_MODE);
  const settingsPath = path.join(dir, 'settings.json');
  const settings = buildHookSettings({ ...rest, glimmervoidId, token: tok });
  writeJsonAtomicSync(settingsPath, settings, { mode: FILE_MODE, enforceMode: true });
  return {
    settingsPath,
    dir,
    token: tok,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
      }
    },
  };
}

function sweepOrphans(baseDir: string = DEFAULT_BASE_DIR, maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  let baseStat: fs.Stats;
  try {
    baseStat = fs.lstatSync(baseDir);
  } catch {
    return 0;
  }
  const ownedByUs = typeof process.getuid !== 'function' || baseStat.uid === process.getuid();
  if (!baseStat.isDirectory() || !ownedByUs) {
    console.warn(`[hooks] refusing to sweep ${baseDir}: not a directory this user owns`);
    return 0;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const p = path.join(baseDir, ent.name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) {
        fs.rmSync(p, { recursive: true, force: true });
        removed++;
      }
    } catch {
    }
  }
  return removed;
}

export { buildHookSettings, describeInstalledClaudeHooks, writeSessionSettings, sweepOrphans, generateToken, HOOK_EVENTS, DEFAULT_TIMEOUT_SEC, PLAN_HOLD_RELEASE_MS, FILE_MODE, RELAY_LAUNCH, COMMAND_HOOK_RELAY_LAUNCH, NO_CHAIN };
