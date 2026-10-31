import { SESSION_COMMANDS } from '../../shared/contracts/session.ts';
import type { AgentApiVerb, SessionCommand, SessionLimits } from '../../shared/contracts/session.ts';
import { isRecord } from '../../shared/coerce.ts';

const SUPERVISION_LINE = "Glimmervoid supervises this session. Run glimmervoid --help for the commands it gives you and this session's limits.";
const SPAWN_LINE = 'To delegate work that edits files or runs long, use glimmervoid spawn rather than an in-process subagent: the spawned session gets its own dashboard card the operator can watch. An in-process subagent stays fine for a quick read-only lookup.';
const HELP_COMMAND = 'glimmervoid --help';
const SHELL_TOOL_RULE = 'Bash';
const SHELL_PREFIX_RULE = /^Bash\((.+):\*\)$/;
const NEVER_ASK_MODE = 'dontAsk';
const NO_OWN_WORKTREE_REASON = 'this session has no worktree of its own, so there is nothing of its own to land';

interface SessionRoleFacts {
  isEphemeral: boolean;
  isSpawnedChild: boolean;
  hasOwnWorktree: boolean;
}

type SessionKindFacts = Omit<SessionRoleFacts, 'hasOwnWorktree'>;

interface SessionLimitFacts extends SessionRoleFacts {
  environment: SessionLimits['environment'];
}

type PushRefusalCode = 'not-operator-session' | 'no-worktree';
type RouteVerdict = { answers: true } | { answers: false; reason: string; code?: PushRefusalCode };

type SessionCommandLimit = SessionLimits['commands'][number];

const ANSWERS: { answers: true } = Object.freeze({ answers: true });

function supervisionLine({ canSpawn = false }: { canSpawn?: boolean }): string {
  if (!canSpawn) return SUPERVISION_LINE;
  return `${SUPERVISION_LINE} ${SPAWN_LINE}`;
}

function coversHelpCommand(permissionRule: unknown): boolean {
  if (typeof permissionRule !== 'string') return false;
  if (permissionRule === SHELL_TOOL_RULE) return true;
  const commandPrefix = SHELL_PREFIX_RULE.exec(permissionRule)?.[1];
  if (commandPrefix === undefined) return false;
  return HELP_COMMAND === commandPrefix || HELP_COMMAND.startsWith(`${commandPrefix} `);
}

function permissionRules(listed: unknown): unknown[] {
  return Array.isArray(listed) ? listed : [];
}

function permitsHelpCommand(settingsPermissions: Record<string, unknown> | null): boolean {
  if (settingsPermissions === null) return true;
  if (permissionRules(settingsPermissions.deny).some(coversHelpCommand)) return false;
  if (settingsPermissions.defaultMode !== NEVER_ASK_MODE) return true;
  return permissionRules(settingsPermissions.allow).some(coversHelpCommand);
}

function pushRoute({ isEphemeral, isSpawnedChild, hasOwnWorktree }: SessionRoleFacts): RouteVerdict {
  if (isEphemeral && !isSpawnedChild) {
    return { answers: false, code: 'not-operator-session', reason: 'only an operator session or a session it spawned can push' };
  }
  if (!hasOwnWorktree) return { answers: false, code: 'no-worktree', reason: NO_OWN_WORKTREE_REASON };
  return ANSWERS;
}

function spawnRoute({ isEphemeral, isSpawnedChild }: SessionKindFacts): RouteVerdict {
  if (isSpawnedChild) return { answers: false, reason: 'a spawned session may not spawn another' };
  if (isEphemeral) {
    return { answers: false, reason: "only an operator session may spawn a session, because the new session gets an operator session's tools and permissions, which can be wider than this one's" };
  }
  return ANSWERS;
}

function hasOperatorCard({ isEphemeral, isSpawnedChild }: SessionKindFacts): boolean {
  if (!isEphemeral) return true;
  return isSpawnedChild;
}

function attentionRoute(caller: SessionKindFacts): RouteVerdict {
  if (hasOperatorCard(caller)) return ANSWERS;
  return { answers: false, reason: 'a lane session cannot raise attention, because its notes are not delivered to the operator' };
}

function editRoute(caller: SessionKindFacts): RouteVerdict {
  if (hasOperatorCard(caller)) return ANSWERS;
  return { answers: false, reason: 'a lane session cannot surface a file, because it has no card for the operator to open the file from' };
}

function showRoute(caller: SessionKindFacts): RouteVerdict {
  if (hasOperatorCard(caller)) return ANSWERS;
  return { answers: false, reason: 'a lane session cannot show a file, because it has no card for the operator to see it on' };
}

function operatorStateRoute(caller: SessionKindFacts): RouteVerdict {
  if (hasOperatorCard(caller)) return ANSWERS;
  return { answers: false, reason: "a lane session cannot read or queue the operator's reviews, pull requests or settings, because a lane runs on input the operator has not vetted" };
}

function channelRoute(caller: SessionKindFacts): RouteVerdict {
  if (hasOperatorCard(caller)) return ANSWERS;
  return { answers: false, reason: 'a lane session has no parent or spawned sessions to message' };
}

function closeRoute({ isEphemeral, isSpawnedChild }: SessionKindFacts): RouteVerdict {
  if (isSpawnedChild) return { answers: false, reason: 'a spawned session owns no sessions to close' };
  if (isEphemeral) return { answers: false, reason: 'a lane session owns no sessions to close' };
  return ANSWERS;
}

function linkPrRoute(caller: SessionKindFacts): RouteVerdict {
  if (hasOperatorCard(caller)) return ANSWERS;
  return { answers: false, reason: 'a lane session cannot link a pull request, because it has no card to show the link on' };
}

function whiteboardRoute(caller: SessionKindFacts): RouteVerdict {
  if (hasOperatorCard(caller)) return ANSWERS;
  return { answers: false, reason: 'a lane session cannot use a whiteboard, because a lane runs on input the operator has not vetted and has no card to show the board on' };
}

const COMMAND_ROUTES: Readonly<Record<AgentApiVerb, (facts: SessionRoleFacts) => RouteVerdict>> = Object.freeze({
  push: pushRoute,
  spawn: spawnRoute,
  send: channelRoute,
  read: channelRoute,
  close: closeRoute,
  answer: closeRoute,
  attention: attentionRoute,
  board: () => ANSWERS,
  edit: editRoute,
  show: showRoute,
  review: operatorStateRoute,
  reviews: operatorStateRoute,
  prs: operatorStateRoute,
  'link-pr': linkPrRoute,
  settings: operatorStateRoute,
  whiteboard: whiteboardRoute,
  limits: () => ANSWERS,
});

type HintedCommand = 'show' | 'spawn' | 'push' | 'settings' | 'review';
type ToolHookEvent = 'posttooluse' | 'posttoolusefailure';

interface ToolHookFacts {
  event: ToolHookEvent;
  toolName: string;
  toolInput: Record<string, unknown>;
}

interface HintGate {
  answers: (command: HintedCommand) => boolean;
  hintedCommands: ReadonlySet<string>;
  ranCommands: ReadonlySet<string>;
}

interface CommandHint {
  command: HintedCommand;
  event: ToolHookEvent;
  text: string;
}

const SHOWABLE_PATH = /\.(png|jpe?g|gif|webp|svg|mp4|webm|html?)(?=$|[\s'"`)|;&,])/i;
const FILE_WRITING_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit']);
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash']);
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);
const GIT_PUSH = /\bgit\s+push\b/;
const PR_REVIEW = /\bgh\s+pr\s+review\b/;
const GLIMMERVOID_CONFIG = /\.glimmervoid[\\/]config\.json\b/;

function shellCommandOf({ toolName, toolInput }: ToolHookFacts): string | null {
  if (!SHELL_TOOLS.has(toolName)) return null;
  return typeof toolInput.command === 'string' ? toolInput.command : null;
}

function filePathOf({ toolName, toolInput }: ToolHookFacts): string | null {
  if (!FILE_WRITING_TOOLS.has(toolName)) return null;
  return typeof toolInput.file_path === 'string' ? toolInput.file_path : null;
}

function namesShowableFile(facts: ToolHookFacts): boolean {
  if (facts.event !== 'posttooluse') return false;
  const named = filePathOf(facts) ?? shellCommandOf(facts);
  return named !== null && SHOWABLE_PATH.test(named);
}

function startsSubagent(facts: ToolHookFacts): boolean {
  return facts.event === 'posttooluse' && SUBAGENT_TOOLS.has(facts.toolName);
}

function failsGitPush(facts: ToolHookFacts): boolean {
  if (facts.event !== 'posttoolusefailure') return false;
  return GIT_PUSH.test(shellCommandOf(facts) ?? '');
}

function touchesGlimmervoidConfig(facts: ToolHookFacts): boolean {
  const named = filePathOf(facts) ?? shellCommandOf(facts);
  return named !== null && GLIMMERVOID_CONFIG.test(named);
}

function runsPullRequestReview(facts: ToolHookFacts): boolean {
  if (facts.event !== 'posttooluse') return false;
  return PR_REVIEW.test(shellCommandOf(facts) ?? '');
}

const COMMAND_HINTS: Readonly<Record<HintedCommand, { firesOn: (facts: ToolHookFacts) => boolean; text: string }>> = Object.freeze({
  show: { firesOn: namesShowableFile, text: 'Glimmervoid: glimmervoid show <path> puts an image, video or HTML file on this session\'s card for the operator.' },
  spawn: { firesOn: startsSubagent, text: 'Glimmervoid: for work that edits files or runs long, glimmervoid spawn <prompt> gives it its own dashboard card; an in-process subagent stays fine for a quick read-only lookup.' },
  push: { firesOn: failsGitPush, text: "Glimmervoid: glimmervoid push lands this session's commits on the integration branch and pushes it." },
  settings: { firesOn: touchesGlimmervoidConfig, text: "Glimmervoid: glimmervoid settings get <key> reads Glimmervoid's settings without opening config.json." },
  review: { firesOn: runsPullRequestReview, text: 'Glimmervoid: glimmervoid review <pr> queues a team review whose draft waits in the Reviews tab for the operator to post.' },
});

const HINTED_COMMANDS = Object.keys(COMMAND_HINTS) as HintedCommand[];
const TOOL_HOOK_EVENTS: ReadonlySet<string> = new Set<ToolHookEvent>(['posttooluse', 'posttoolusefailure']);

function isToolHookEvent(event: string): event is ToolHookEvent {
  return TOOL_HOOK_EVENTS.has(event);
}

function toolHookFactsOf(event: string, payload: Record<string, unknown>): ToolHookFacts | null {
  const normalizedEvent = event.toLowerCase();
  if (!isToolHookEvent(normalizedEvent)) return null;
  if (typeof payload.tool_name !== 'string') return null;
  return { event: normalizedEvent, toolName: payload.tool_name, toolInput: isRecord(payload.tool_input) ? payload.tool_input : {} };
}

function hintFor(facts: ToolHookFacts, gate: HintGate): CommandHint | null {
  const command = HINTED_COMMANDS.find((candidate) => !gate.hintedCommands.has(candidate)
    && !gate.ranCommands.has(candidate)
    && COMMAND_HINTS[candidate].firesOn(facts)
    && gate.answers(candidate));
  if (command === undefined) return null;
  return { command, event: facts.event, text: COMMAND_HINTS[command].text };
}

function commandLimit(name: SessionCommand, facts: SessionRoleFacts): SessionCommandLimit {
  const verdict = COMMAND_ROUTES[name](facts);
  if (verdict.answers) return { name, answers: true };
  return { name, answers: false, reason: verdict.reason };
}

function sessionBoundary({ environment }: SessionLimitFacts): SessionLimits['boundary'] {
  return environment === null ? 'none' : 'workspace';
}

function describeSessionLimits(facts: SessionLimitFacts): SessionLimits {
  return {
    commands: SESSION_COMMANDS.map((name) => commandLimit(name, facts)),
    boundary: sessionBoundary(facts),
    environment: facts.environment,
  };
}

function boundaryLines({ boundary, environment }: SessionLimits): string[] {
  if (environment === null) return [`  boundary: ${boundary}`];
  return [`  boundary: ${boundary}`, `  environment: ${environment.name}, workspace ${environment.workspace}, ${environment.state}`];
}

function formatSessionLimits(limits: SessionLimits): string[] {
  const commandLines = limits.commands.map(({ name, answers, reason }) => (answers ? `  ${name}: available` : `  ${name}: not available, ${reason}`));
  return ['This session:', ...commandLines, ...boundaryLines(limits)];
}

export type { CommandHint, HintedCommand };
export { supervisionLine, permitsHelpCommand, toolHookFactsOf, hintFor, COMMAND_ROUTES, describeSessionLimits, formatSessionLimits, NO_OWN_WORKTREE_REASON };
export type { SessionRoleFacts };
