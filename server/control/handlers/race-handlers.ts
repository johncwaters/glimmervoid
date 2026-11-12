import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import { winnerNotesPrompt } from '../../race/core/race-core.ts';
import { CONTESTANT_PROMPT_TIMEOUT_MS, createRaceLauncher } from '../../race/race-launch.ts';
import type { RaceLauncher } from '../../race/race-launch.ts';
import type { ControlContext } from '../control-context.ts';
import { replyTo } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';
import type { DiscardSession } from './session-handlers.ts';

function createRaceHandlers(context: ControlContext, deps: ControlHandlerDeps, { discardSession }: { discardSession: DiscardSession }): ControlHandlerGroup & { launcher: RaceLauncher } {
  const { sessions, createProjectSession } = context;
  const { config, races = null } = deps;
  const launcher = createRaceLauncher({ races, sessions, config, createProjectSession });

  async function handleRaceStart(msg: ClientMessageOf<'race-start'>, ws: ControlSocket): Promise<void> {
    const started = await launcher.start(msg.spec, launcher.machineDefaultPermissions());
    replyTo(ws, msg, 'race-start-result', started.ok ? { ok: true, error: started.error, raceId: started.raceId } : { ok: false, error: started.error });
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
      const pasted = winner.deliver(winnerNotesPrompt(picked.notes), { when: 'ready', submit: true, timeoutMs: CONTESTANT_PROMPT_TIMEOUT_MS });
      if (!pasted.ok) problems.push(`Could not send the judge's notes (${pasted.reason})`);
    }
    if (msg.sendNotes && !picked.notes) problems.push('The judge left no notes for the winner, so none were sent.');
    reply({ ok: problems.length === 0, error: problems.length > 0 ? problems.join(' ') : null });
  }

  async function handleRaceCases(msg: ClientMessageOf<'race-cases'>, ws: ControlSocket): Promise<void> {
    const listed = races ? await races.listCases() : { ok: false as const, error: 'Races are not running' };
    replyTo(ws, msg, 'race-cases-result', listed.ok ? { ok: true, error: null, cases: listed.cases } : { ok: false, error: listed.error });
  }

  async function handleRaceMineCases(msg: ClientMessageOf<'race-mine-cases'>, ws: ControlSocket): Promise<void> {
    const mined = races ? await races.mineCases(msg.repo) : { ok: false as const, error: 'Races are not running' };
    replyTo(ws, msg, 'race-mine-cases-result', mined.ok ? { ok: true, error: null, mined: mined.mined, refused: mined.refused } : { ok: false, error: mined.error });
  }

  const handlers = {
    'race-start': handleRaceStart,
    'race-judge': handleRaceJudge,
    'race-diff': handleRaceDiff,
    'race-pick-winner': handleRacePickWinner,
    'race-cases': handleRaceCases,
    'race-mine-cases': handleRaceMineCases,
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'race-start': (_msg, requestId, message) => ({ type: 'race-start-result', requestId, ok: false, error: message }),
    'race-judge': (_msg, requestId, message) => ({ type: 'race-judge-result', requestId, ok: false, error: message }),
    'race-diff': (_msg, requestId, message) => ({ type: 'race-diff-result', requestId, ok: false, error: message }),
    'race-pick-winner': (_msg, requestId, message) => ({ type: 'race-pick-winner-result', requestId, ok: false, error: message }),
    'race-cases': (_msg, requestId, message) => ({ type: 'race-cases-result', requestId, ok: false, error: message }),
    'race-mine-cases': (_msg, requestId, message) => ({ type: 'race-mine-cases-result', requestId, ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies, connectFrames: () => (races ? [races.status(), races.historyFrame()] : []), launcher };
}

export { createRaceHandlers };
