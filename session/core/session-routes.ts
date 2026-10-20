import { SESSION_COMMANDS } from '../../shared/contracts/session.ts';
import type { AgentApiVerb, SessionCommand, SessionLimits } from '../../shared/contracts/session.ts';

const SUPERVISION_LINE = "Glimmervoid supervises this session. Run glimmervoid --help for the commands it gives you and this session's limits.";
const GUARDRAILS_LINE = 'Its guardrails are OS-enforced, so a read, write or connection they refuse will not succeed on retry.';
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
  isGuarded: boolean;
}

type PushRefusalCode = 'not-operator-session' | 'no-worktree';
type RouteVerdict = { answers: true } | { answers: false; reason: string; code?: PushRefusalCode };

type SessionCommandLimit = SessionLimits['commands'][number];
type SessionDeadEnd = SessionLimits['deadEnds'][number];

const ANSWERS: { answers: true } = Object.freeze({ answers: true });

function supervisionLine({ isGuarded }: { isGuarded: boolean }): string {
  if (!isGuarded) return SUPERVISION_LINE;
  return `${SUPERVISION_LINE} ${GUARDRAILS_LINE}`;
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
    return { answers: false, reason: "only an operator session may spawn a session, because the new session gets an operator session's guardrails, which can be wider than this one's" };
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

const COMMAND_ROUTES: Readonly<Record<AgentApiVerb, (facts: SessionRoleFacts) => RouteVerdict>> = Object.freeze({
  push: pushRoute,
  spawn: spawnRoute,
  send: channelRoute,
  read: channelRoute,
  close: closeRoute,
  attention: attentionRoute,
  board: () => ANSWERS,
  edit: editRoute,
  review: operatorStateRoute,
  reviews: operatorStateRoute,
  prs: operatorStateRoute,
  'link-pr': linkPrRoute,
  settings: operatorStateRoute,
  limits: () => ANSWERS,
});

function commandLimit(name: SessionCommand, facts: SessionRoleFacts): SessionCommandLimit {
  const verdict = COMMAND_ROUTES[name](facts);
  if (verdict.answers) return { name, answers: true };
  return { name, answers: false, reason: verdict.reason };
}

function runsUnderOperatorSessionGuardrails({ isGuarded, isEphemeral, isSpawnedChild }: SessionLimitFacts): boolean {
  if (!isGuarded) return false;
  return !isEphemeral || isSpawnedChild;
}

const OPERATOR_SESSION_GUARDRAIL_DEAD_ENDS: readonly SessionDeadEnd[] = Object.freeze([
  {
    blocked: "credential folders, Glimmervoid's own folder and any path the operator blocked are off limits",
    route: 'flag the operator with glimmervoid attention',
  },
]);

function describeSessionLimits(facts: SessionLimitFacts): SessionLimits {
  return {
    commands: SESSION_COMMANDS.map((name) => commandLimit(name, facts)),
    guarded: facts.isGuarded,
    deadEnds: runsUnderOperatorSessionGuardrails(facts) ? [...OPERATOR_SESSION_GUARDRAIL_DEAD_ENDS] : [],
  };
}

function formatSessionLimits({ commands, guarded, deadEnds }: SessionLimits): string[] {
  const commandLines = commands.map(({ name, answers, reason }) => (answers ? `  ${name}: available` : `  ${name}: not available, ${reason}`));
  if (!guarded) return ['This session:', ...commandLines, '  guardrails: none'];
  return [
    'This session:',
    ...commandLines,
    '  guardrails: OS-enforced, so a read, write or connection they refuse will not succeed on retry',
    ...deadEnds.map(({ blocked, route }) => `  ${blocked}: ${route}`),
  ];
}

export { supervisionLine, permitsHelpCommand, COMMAND_ROUTES, describeSessionLimits, formatSessionLimits, NO_OWN_WORKTREE_REASON };
export type { SessionRoleFacts };
