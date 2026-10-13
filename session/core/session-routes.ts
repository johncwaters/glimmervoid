import { SESSION_COMMANDS } from '../../shared/contracts/session.ts';
import type { SessionCommand, SessionLimits } from '../../shared/contracts/session.ts';

const SUPERVISION_LINE = "Glimmervoid supervises this session. Run glimmervoid --help for the commands it gives you and this session's limits.";
const SANDBOX_LINE = 'It runs in an OS-enforced sandbox, so a refused write or connection will not succeed on retry.';
const NO_OWN_WORKTREE_REASON = 'this session has no worktree of its own, so there is nothing of its own to land';

interface SessionRoleFacts {
  isEphemeral: boolean;
  isSpawnedChild: boolean;
  factoryRole: 'orchestrator' | 'worker' | null;
  hasOwnWorktree: boolean;
}

type SessionKindFacts = Omit<SessionRoleFacts, 'hasOwnWorktree'>;

interface SessionLimitFacts extends SessionRoleFacts {
  isSandboxed: boolean;
}

type RouteVerdict = { answers: true } | { answers: false; reason: string };
type PushRefusalCode = 'not-operator-session' | 'no-worktree';
type PushRouteVerdict = { answers: true } | { answers: false; reason: string; code: PushRefusalCode };

type SessionCommandLimit = SessionLimits['commands'][number];
type SessionDeadEnd = SessionLimits['deadEnds'][number];

const ANSWERS: { answers: true } = Object.freeze({ answers: true });

function supervisionLine({ isSandboxed }: { isSandboxed: boolean }): string {
  if (!isSandboxed) return SUPERVISION_LINE;
  return `${SUPERVISION_LINE} ${SANDBOX_LINE}`;
}

function pushRoute({ isEphemeral, isSpawnedChild, hasOwnWorktree }: SessionRoleFacts): PushRouteVerdict {
  if (isEphemeral && !isSpawnedChild) {
    return { answers: false, code: 'not-operator-session', reason: 'only an operator session or a session it spawned can push' };
  }
  if (!hasOwnWorktree) return { answers: false, code: 'no-worktree', reason: NO_OWN_WORKTREE_REASON };
  return ANSWERS;
}

function spawnRoute({ isEphemeral, isSpawnedChild, factoryRole }: SessionKindFacts): RouteVerdict {
  if (factoryRole === 'worker') return { answers: false, reason: 'the factory starts and counts its workers, so a worker may not spawn a session' };
  if (isSpawnedChild) return { answers: false, reason: 'a spawned session may not spawn another' };
  if (isEphemeral) {
    return { answers: false, reason: 'only an operator session may spawn a session, because the new session gets an operator session sandbox, which can be wider than this one' };
  }
  return ANSWERS;
}

function attentionRoute({ isEphemeral, isSpawnedChild, factoryRole }: SessionKindFacts): RouteVerdict {
  if (!isEphemeral) return ANSWERS;
  if (factoryRole !== null) return ANSWERS;
  if (isSpawnedChild) return ANSWERS;
  return { answers: false, reason: 'a lane session cannot raise attention, because its notes are not delivered to the operator' };
}

const COMMAND_ROUTES: Readonly<Record<SessionCommand, (facts: SessionRoleFacts) => RouteVerdict>> = Object.freeze({
  push: pushRoute,
  spawn: spawnRoute,
  attention: attentionRoute,
  board: () => ANSWERS,
});

function commandLimit(name: SessionCommand, facts: SessionRoleFacts): SessionCommandLimit {
  const verdict = COMMAND_ROUTES[name](facts);
  if (verdict.answers) return { name, answers: true };
  return { name, answers: false, reason: verdict.reason };
}

function runsUnderOperatorSessionSandbox({ isSandboxed, isEphemeral, isSpawnedChild }: SessionLimitFacts): boolean {
  if (!isSandboxed) return false;
  return !isEphemeral || isSpawnedChild;
}

function operatorSessionSandboxDeadEnds(facts: SessionRoleFacts): SessionDeadEnd[] {
  const landingRoute = pushRoute(facts).answers ? 'land your commits with glimmervoid push' : 'leave the merge to the operator';
  return [
    { blocked: 'the main checkout, git hooks and git config are read-only', route: landingRoute },
    { blocked: '/tmp is read-only', route: 'write temporary files under $TMPDIR' },
    {
      blocked: "git over SSH, Docker, the system keyring, unix sockets and edits to the agent's own settings are unavailable",
      route: 'flag the operator with glimmervoid attention',
    },
  ];
}

function describeSessionLimits(facts: SessionLimitFacts): SessionLimits {
  return {
    commands: SESSION_COMMANDS.map((name) => commandLimit(name, facts)),
    sandboxed: facts.isSandboxed,
    deadEnds: runsUnderOperatorSessionSandbox(facts) ? operatorSessionSandboxDeadEnds(facts) : [],
  };
}

function formatSessionLimits({ commands, sandboxed, deadEnds }: SessionLimits): string[] {
  const commandLines = commands.map(({ name, answers, reason }) => (answers ? `  ${name}: available` : `  ${name}: not available, ${reason}`));
  if (!sandboxed) return ['This session:', ...commandLines, '  sandbox: none'];
  return [
    'This session:',
    ...commandLines,
    '  sandbox: OS-enforced, so a refused write or connection will not succeed on retry',
    ...deadEnds.map(({ blocked, route }) => `  ${blocked}: ${route}`),
  ];
}

export { supervisionLine, pushRoute, spawnRoute, attentionRoute, describeSessionLimits, formatSessionLimits, NO_OWN_WORKTREE_REASON };
export type { SessionRoleFacts, RouteVerdict };
