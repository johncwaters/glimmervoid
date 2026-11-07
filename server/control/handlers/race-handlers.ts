import { configIssueMessage, SHELL_AGENT_ID } from '../../../shared/contracts/index.ts';
import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import { RaceJudgeAgent, RaceSpec } from '../../../shared/contracts/race.ts';
import { CatalogAgentId } from '../../../shared/contracts/agent-models.ts';
import type { RaceContestant } from '../../../shared/contracts/race.ts';
import { DEFAULT_AGENT_ID, isKnownAgentId } from '../../../session/adapters/index.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import { contestantPrompt, contestantSessionName, winnerNotesPrompt } from '../../race/core/race-core.ts';
import { machineSkipsPermissionsByDefault } from '../../session/core/session-registry-core.ts';
import type { ControlContext } from '../control-context.ts';
import { isExistingDirectory, missingFolderError, replyTo } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';
import type { DiscardSession } from './session-handlers.ts';

const CONTESTANT_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

function createRaceHandlers(context: ControlContext, deps: ControlHandlerDeps, { discardSession }: { discardSession: DiscardSession }): ControlHandlerGroup {
  const { sessions, createProjectSession } = context;
  const { config, races = null } = deps;

  function launchContestant(spec: RaceSpec, contestant: RaceContestant, race: { raceId: string; startSha: string }) {
    const agent = contestant.setup.agent;
    const created = createProjectSession({
      name: contestantSessionName(spec, contestant),
      path: spec.repoPath,
      agent: agent === DEFAULT_AGENT_ID ? undefined : agent,
      dangerouslySkipPermissions: machineSkipsPermissionsByDefault(config),
      requireExistingPath: true,
      runSettings: { agentSetup: contestant.setup, agentHome: contestant.home, raceId: race.raceId, startSha: race.startSha },
    });
    if (!created.ok) return { ok: false as const, error: created.error };
    const session = sessions.get(created.project.id);
    if (!session) return { ok: false as const, error: `Session "${created.project.name}" is not loaded` };
    const pasted = session.pasteTextWhenReady(contestantPrompt(spec, contestant), { submit: true, timeoutMs: CONTESTANT_PROMPT_TIMEOUT_MS });
    if (!pasted.ok) return { ok: false as const, error: `Could not send the prompt to "${session.name}" (${pasted.reason})` };
    return { ok: true as const, sessionId: session.id };
  }

  async function handleRaceStart(msg: ClientMessageOf<'race-start'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: { ok: boolean; error: string | null; raceId?: string }) => replyTo(ws, msg, 'race-start-result', payload);
    if (!races) {
      reply({ ok: false, error: 'Races are not running' });
      return;
    }
    const parsed = RaceSpec.safeParse(msg.spec);
    if (!parsed.success) {
      reply({ ok: false, error: configIssueMessage(parsed.error) });
      return;
    }
    const spec = parsed.data;
    if (!isExistingDirectory(spec.repoPath)) {
      reply({ ok: false, error: missingFolderError(spec.repoPath) });
      return;
    }
    const unknownAgent = spec.contestants.find((contestant) => contestant.setup.agent === SHELL_AGENT_ID || !isKnownAgentId(contestant.setup.agent));
    if (unknownAgent) {
      reply({ ok: false, error: `"${unknownAgent.setup.agent}" cannot race: a contestant must be a coding agent` });
      return;
    }
    const uncleanable = spec.contestants.find((contestant) => contestant.home === 'clean' && !CatalogAgentId.safeParse(contestant.setup.agent).success);
    if (uncleanable) {
      reply({ ok: false, error: `"${uncleanable.setup.agent}" cannot race in a clean home: only Claude Code, Codex and Kimi Code can` });
      return;
    }
    const unknownJudge = spec.judges.find((judge) => !RaceJudgeAgent.safeParse(judge.setup.agent).success);
    if (unknownJudge) {
      reply({ ok: false, error: `"${unknownJudge.setup.agent}" cannot judge: a judge runs on Claude Code or Codex` });
      return;
    }
    const started = await races.start(spec, (contestant, race) => launchContestant(spec, contestant, race));
    reply(started.ok ? { ok: true, error: started.error, raceId: started.raceId } : { ok: false, error: started.error });
  }

  async function handleRaceJudge(msg: ClientMessageOf<'race-judge'>, ws: ControlSocket): Promise<void> {
    const judged = races ? await races.judge(msg.raceId) : { ok: false as const, error: 'Races are not running' };
    replyTo(ws, msg, 'race-judge-result', judged.ok ? { ok: true, error: null } : { ok: false, error: judged.error });
  }

  async function handleRaceDiff(msg: ClientMessageOf<'race-diff'>, ws: ControlSocket): Promise<void> {
    const diff = races ? await races.contestantDiffText(msg.raceId, msg.contestantId) : { ok: false as const, error: 'Races are not running' };
    replyTo(ws, msg, 'race-diff-result', diff.ok ? { ok: true, error: null, diff: diff.diff } : { ok: false, error: diff.error });
  }

  async function handleRacePickWinner(msg: ClientMessageOf<'race-pick-winner'>, ws: ControlSocket): Promise<void> {
    const reply = (payload: { ok: boolean; error: string | null }) => replyTo(ws, msg, 'race-pick-winner-result', payload);
    if (!races) {
      reply({ ok: false, error: 'Races are not running' });
      return;
    }
    const picked = await races.pickWinner(msg.raceId, msg.contestantId);
    if (!picked.ok) {
      reply({ ok: false, error: picked.error });
      return;
    }
    const problems: string[] = [];
    for (const loserSessionId of picked.loserSessionIds) {
      if (!sessions.has(loserSessionId)) continue;
      const removal = await discardSession(loserSessionId);
      if (!removal.ok) problems.push(removal.error);
    }
    const winner = sessions.get(picked.winnerSessionId);
    if (msg.sendNotes && picked.notes && winner) {
      const pasted = winner.pasteTextWhenReady(winnerNotesPrompt(picked.notes), { submit: true, timeoutMs: CONTESTANT_PROMPT_TIMEOUT_MS });
      if (!pasted.ok) problems.push(`Could not send the judge's notes (${pasted.reason})`);
    }
    if (msg.sendNotes && !picked.notes) problems.push('The judge left no notes for the winner, so none were sent.');
    reply({ ok: problems.length === 0, error: problems.length > 0 ? problems.join(' ') : null });
  }

  const handlers = {
    'race-start': handleRaceStart,
    'race-judge': handleRaceJudge,
    'race-diff': handleRaceDiff,
    'race-pick-winner': handleRacePickWinner,
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'race-start': (_msg, requestId, message) => ({ type: 'race-start-result', requestId, ok: false, error: message }),
    'race-judge': (_msg, requestId, message) => ({ type: 'race-judge-result', requestId, ok: false, error: message }),
    'race-diff': (_msg, requestId, message) => ({ type: 'race-diff-result', requestId, ok: false, error: message }),
    'race-pick-winner': (_msg, requestId, message) => ({ type: 'race-pick-winner-result', requestId, ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies, connectFrames: () => (races ? [races.status(), races.historyFrame()] : []) };
}

export { createRaceHandlers };
