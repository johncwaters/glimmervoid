import { configIssueMessage, SHELL_AGENT_ID } from '../../../shared/contracts/index.ts';
import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import { RaceSpec } from '../../../shared/contracts/race.ts';
import type { RaceContestant } from '../../../shared/contracts/race.ts';
import { DEFAULT_AGENT_ID, isKnownAgentId } from '../../../session/adapters/index.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import { contestantPrompt, contestantSessionName } from '../../race/core/race-core.ts';
import { machineSkipsPermissionsByDefault } from '../../session/core/session-registry-core.ts';
import type { ControlContext } from '../control-context.ts';
import { isExistingDirectory, missingFolderError, replyTo } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';

const CONTESTANT_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

function createRaceHandlers(context: ControlContext, deps: ControlHandlerDeps): ControlHandlerGroup {
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
      runSettings: { agentSetup: contestant.setup, raceId: race.raceId, startSha: race.startSha },
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
    const started = await races.start(spec, (contestant, race) => launchContestant(spec, contestant, race));
    reply(started.ok ? { ok: true, error: started.error, raceId: started.raceId } : { ok: false, error: started.error });
  }

  const handlers = {
    'race-start': handleRaceStart,
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'race-start': (_msg, requestId, message) => ({ type: 'race-start-result', requestId, ok: false, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies, connectFrames: () => (races ? [races.status()] : []) };
}

export { createRaceHandlers };
