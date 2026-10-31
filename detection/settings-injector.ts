import { loadJsonStateFileSync, loadedJsonValue, writeJsonAtomicSync } from '../server/json-file.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { hostScratchRoot } from '../server/host-scratch.ts';
import { relayPath } from '../server/runtime-paths.ts';
import { shellQuote } from '../session/core/hook-command-core.ts';
import { HOOK_TOOLS } from '../session/core/hook-tools.ts';
import type { ResolvedHookTool } from '../session/core/hook-tools.ts';
import { appendUserHooks } from '../session/core/user-hooks-core.ts';
import type { UserHook } from '../session/core/user-hooks-core.ts';
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
  defaultMode?: string;
}

interface HookSettings {
  hooks: Record<string, SettingsHookEntry[]>;
  permissions?: SessionPermissions;
  enableAllProjectMcpServers?: boolean;
  statusLine?: { type: string; command: string };
  awaySummaryEnabled?: boolean;
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
  holdsQuestionsForParent?: boolean;
  userSettingsPath?: string | null;
  relayPath?: string;
  commandHookRelayPath?: string;
  hookToolRelayPath?: string;
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

const RELAY_PATH = relayPath('statusline-relay');
const COMMAND_HOOK_RELAY_PATH = relayPath('command-hook-relay');
const HOOK_TOOL_RELAY_PATH = relayPath('hook-tool-relay');
const NO_CHAIN = '-';

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function toForwardSlashes(value: string): string {
  return String(value).replace(/\\/g, '/');
}

interface OperatorClaudeSettings {
  statuslineCommand: string | null;
  awaySummaryEnabled: boolean | null;
}

const NO_OPERATOR_SETTINGS: OperatorClaudeSettings = { statuslineCommand: null, awaySummaryEnabled: null };

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
      };
    },
  })) ?? NO_OPERATOR_SETTINGS;
}

function buildStatuslineCommand(
  { relayPath = RELAY_PATH, postUrl, userCommand = null }:
    { relayPath?: string; postUrl: string; userCommand?: string | null },
): string {
  const encoded = userCommand ? Buffer.from(userCommand, 'utf8').toString('base64') : NO_CHAIN;
  return `node ${shellQuote(toForwardSlashes(relayPath))} ${shellQuote(postUrl)} ${shellQuote(encoded)}`;
}

function buildCommandHookCommand(
  { relayPath = COMMAND_HOOK_RELAY_PATH, postUrl }: { relayPath?: string; postUrl: string },
): string {
  return `node ${shellQuote(toForwardSlashes(relayPath))} ${shellQuote(postUrl)}`;
}

function buildRemoteCommandHookCommand({ nodePath, postUrl }: { nodePath: string; postUrl: string }): string {
  const inlineRelay = 'let body="";process.stdin.setEncoding("utf8").on("data",(chunk)=>{body+=chunk}).on("end",()=>{'
    + 'fetch(process.argv[1],{method:"POST",headers:{"content-type":"application/json"},body,signal:AbortSignal.timeout(4000)})'
    + '.then((response)=>response.ok?response.text():"").then((text)=>{if(text)process.stdout.write(text)}).catch(()=>{})})';
  return `${shellQuote(nodePath)} -e ${shellQuote(inlineRelay)} ${shellQuote(postUrl)}`;
}

function buildHookSettings({ port, glimmervoidId, token, timeoutSec = DEFAULT_TIMEOUT_SEC, permissions = null, detectScheduledWakeups = true, observeToolCalls = false, enableProjectMcp = false, hookTools = [], planLimits = false, planReview = false, holdsQuestionsForParent = false, userSettingsPath = null, relayPath = RELAY_PATH, commandHookRelayPath = COMMAND_HOOK_RELAY_PATH, hookToolRelayPath = HOOK_TOOL_RELAY_PATH, userHooks = [], remoteNodePath = null }: BuildHookSettingsOptions): HookSettings {
  if (!port || !glimmervoidId || !token) {
    throw new Error('buildHookSettings requires port, glimmervoidId, token');
  }
  const base = `http://127.0.0.1:${port}/hook/${encodeURIComponent(glimmervoidId)}`;
  const hookUrl = (event: string) => `${base}/${event.toLowerCase()}?t=${encodeURIComponent(token)}`;
  const hooks: Record<string, SettingsHookEntry[]> = {
    SessionStart: [{ hooks: [{
      type: 'command',
      command: remoteNodePath === null
        ? buildCommandHookCommand({ relayPath: commandHookRelayPath, postUrl: hookUrl('SessionStart') })
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
  if (holdsQuestionsForParent && permissionRequestEntries) {
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
  if (holdsQuestionsForParent) {
    postToolUse.push({
      matcher: ASK_USER_QUESTION_TOOL_NAME,
      hooks: [{ type: 'http', url: hookUrl(CONVERSATION_TOOL_RESULT_HOOK_EVENT), timeout: timeoutSec }],
    });
  }
  if (postToolUse.length > 0) {
    hooks.PostToolUse = postToolUse;
  }
  hooks.PostToolUseFailure = [{ matcher: FAILED_SHELL_TOOL_MATCHER, hooks: [{ type: 'http', url: hookUrl('PostToolUseFailure'), timeout: timeoutSec }] }];
  const preToolUse: SettingsHookEntry[] = [];
  if (observeToolCalls) {
    preToolUse.push({ hooks: [{ type: 'http', url: hookUrl('PreToolUse'), timeout: timeoutSec }] });
  }
  for (const tool of hookTools) preToolUse.push(HOOK_TOOLS[tool.id].claudeEntry(tool, hookToolRelayPath));
  if (preToolUse.length > 0) {
    hooks.PreToolUse = preToolUse;
  }
  appendUserHooks(hooks, Array.isArray(userHooks) ? userHooks : []);
  const settings: HookSettings = { hooks };
  const allowRules = permissions && Array.isArray(permissions.allow) ? permissions.allow.slice() : [];
  const denyRules = permissions && Array.isArray(permissions.deny) ? permissions.deny.slice() : [];
  const defaultMode = permissions && typeof permissions.defaultMode === 'string' ? permissions.defaultMode : null;
  if (allowRules.length > 0 || denyRules.length > 0 || defaultMode) {
    settings.permissions = {};
    if (allowRules.length > 0) settings.permissions.allow = allowRules;
    if (denyRules.length > 0) settings.permissions.deny = denyRules;
    if (defaultMode) settings.permissions.defaultMode = defaultMode;
  }
  if (enableProjectMcp) {
    settings.enableAllProjectMcpServers = true;
  }
  const operatorSettingsPath = userSettingsPath || path.join(os.homedir(), '.claude', 'settings.json');
  const operatorSettings = readOperatorClaudeSettings(operatorSettingsPath);
  if (operatorSettings.awaySummaryEnabled !== null) {
    settings.awaySummaryEnabled = operatorSettings.awaySummaryEnabled;
  }
  if (planLimits) {
    settings.statusLine = {
      type: 'command',
      command: buildStatuslineCommand({
        relayPath,
        postUrl: `${base}/statusline?t=${encodeURIComponent(token)}`,
        userCommand: operatorSettings.statuslineCommand,
      }),
    };
  }
  return settings;
}

function describeBuiltinHooks(
  { detectScheduledWakeups = true, observeToolCalls = false, hookTools = [], planReview = false, holdsQuestionsForParent = false }:
    { detectScheduledWakeups?: boolean; observeToolCalls?: boolean; hookTools?: ResolvedHookTool[]; planReview?: boolean; holdsQuestionsForParent?: boolean } = {},
): { event: string; matcher: string | null; purpose: string }[] {
  const rows = HOOK_EVENTS.map((event) => ({ event, matcher: null as string | null, purpose: 'Status detection: POST to the Glimmervoid hook router' }));
  if (planReview) rows.push({ event: 'PermissionRequest', matcher: PLAN_TOOL_MATCHER, purpose: 'Plan review: POST the plan to the Glimmervoid plan endpoint' });
  if (detectScheduledWakeups) rows.push({ event: 'PostToolUse', matcher: WAKEUP_TOOL_MATCHER, purpose: 'Scheduled wakeup tracking' });
  rows.push({ event: 'PostToolUse', matcher: PR_LINK_TOOL_MATCHER, purpose: 'Pull request linking: read the git operation a shell command reports' });
  rows.push({ event: 'PostToolUse', matcher: COMMAND_HINT_TOOL_MATCHER, purpose: 'Command hints: name a Glimmervoid command once, when a tool call shows it applies' });
  rows.push({ event: 'PostToolUseFailure', matcher: FAILED_SHELL_TOOL_MATCHER, purpose: 'Command hints: name glimmervoid push once, when a git push fails' });
  rows.push({ event: 'PostToolUse', matcher: ASK_USER_QUESTION_TOOL_NAME, purpose: 'Status detection: leave Needs input once a question is answered' });
  if (planReview) rows.push({ event: 'PostToolUse', matcher: PLAN_TOOL_MATCHER, purpose: 'Plan review: record the approved plan' });
  if (holdsQuestionsForParent) {
    rows.push({ event: 'PermissionRequest', matcher: ASK_USER_QUESTION_TOOL_NAME, purpose: 'Spawned session: hold a question so the parent can answer it' });
    rows.push({ event: 'PostToolUse', matcher: ASK_USER_QUESTION_TOOL_NAME, purpose: 'Spawned session: release a held question the terminal answered' });
  }
  if (observeToolCalls) rows.push({ event: 'PreToolUse', matcher: null, purpose: 'Investigation trail: POST every tool call to the Glimmervoid hook router' });
  for (const tool of hookTools) {
    const descriptor = HOOK_TOOLS[tool.id];
    rows.push({ event: 'PreToolUse', matcher: descriptor.claudeEntry(tool, HOOK_TOOL_RELAY_PATH).matcher, purpose: descriptor.purpose });
  }
  return rows;
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

export { buildHookSettings, describeBuiltinHooks, writeSessionSettings, sweepOrphans, generateToken, HOOK_EVENTS, DEFAULT_TIMEOUT_SEC, PLAN_HOLD_RELEASE_MS, FILE_MODE, RELAY_PATH, COMMAND_HOOK_RELAY_PATH, NO_CHAIN };
