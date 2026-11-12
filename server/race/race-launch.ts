import { configIssueMessage, SHELL_AGENT_ID } from '../../shared/contracts/index.ts';
import { CatalogAgentId } from '../../shared/contracts/agent-models.ts';
import { RaceJudgeAgent, RaceSpec } from '../../shared/contracts/race.ts';
import type { RaceContestant } from '../../shared/contracts/race.ts';
import { DEFAULT_AGENT_ID, isKnownAgentId } from '../../session/adapters/index.ts';
import type { GlimmervoidConfig } from '../config-store.ts';
import type { ControlContext } from '../control/control-context.ts';
import { isExistingDirectory, missingFolderError } from '../control/control-context.ts';
import { machineSkipsPermissionsByDefault } from '../session/core/session-registry-core.ts';
import { contestantPrompt, contestantSessionName } from './core/race-core.ts';
import type { RaceWiring } from './race-wiring.ts';

const CONTESTANT_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

type RaceStartResult = { ok: true; raceId: string; error: string | null } | { ok: false; error: string };

interface ContestantPermissions {
  dangerouslySkipPermissions: boolean;
  saneYolo: boolean;
}

interface RaceLauncher {
  start(spec: unknown, permissions: ContestantPermissions): Promise<RaceStartResult>;
  machineDefaultPermissions(): ContestantPermissions;
}

interface RaceLauncherDeps {
  races: Pick<RaceWiring, 'start'> | null;
  sessions: ControlContext['sessions'];
  config: GlimmervoidConfig;
  createProjectSession: ControlContext['createProjectSession'];
}

function refusalOf(spec: RaceSpec): string | null {
  if (!isExistingDirectory(spec.repoPath)) return missingFolderError(spec.repoPath);
  const unknownAgent = spec.contestants.find((contestant) => contestant.setup.agent === SHELL_AGENT_ID || !isKnownAgentId(contestant.setup.agent));
  if (unknownAgent) return `"${unknownAgent.setup.agent}" cannot race: a contestant must be a coding agent`;
  const uncleanable = spec.contestants.find((contestant) => contestant.home === 'clean' && !CatalogAgentId.safeParse(contestant.setup.agent).success);
  if (uncleanable) return `"${uncleanable.setup.agent}" cannot race in a clean home: only Claude Code, Codex and Kimi Code can`;
  const unknownJudge = spec.judges.find((judge) => !RaceJudgeAgent.safeParse(judge.setup.agent).success);
  if (unknownJudge) return `"${unknownJudge.setup.agent}" cannot judge: a judge runs on Claude Code or Codex`;
  return null;
}

function createRaceLauncher({ races, sessions, config, createProjectSession }: RaceLauncherDeps): RaceLauncher {
  function launchContestant(spec: RaceSpec, contestant: RaceContestant, race: { raceId: string; startSha: string }, permissions: ContestantPermissions) {
    const agent = contestant.setup.agent;
    const created = createProjectSession({
      name: contestantSessionName(spec, contestant),
      path: spec.repoPath,
      agent: agent === DEFAULT_AGENT_ID ? undefined : agent,
      dangerouslySkipPermissions: permissions.dangerouslySkipPermissions,
      saneYolo: permissions.saneYolo,
      requireExistingPath: true,
      runSettings: { agentSetup: contestant.setup, agentHome: contestant.home, raceId: race.raceId, startSha: race.startSha, ...(spec.reviewCase ? { isStartPinned: true } : {}) },
    });
    if (!created.ok) return { ok: false as const, error: created.error };
    const session = sessions.get(created.project.id);
    if (!session) return { ok: false as const, error: `Session "${created.project.name}" is not loaded` };
    const pasted = session.deliver(contestantPrompt(spec, contestant), { when: 'ready', submit: true, timeoutMs: CONTESTANT_PROMPT_TIMEOUT_MS });
    if (!pasted.ok) return { ok: false as const, error: `Could not send the prompt to "${session.name}" (${pasted.reason})` };
    return { ok: true as const, sessionId: session.id };
  }

  function machineDefaultPermissions(): ContestantPermissions {
    return { dangerouslySkipPermissions: machineSkipsPermissionsByDefault(config), saneYolo: false };
  }

  async function start(candidate: unknown, permissions: ContestantPermissions): Promise<RaceStartResult> {
    if (!races) return { ok: false, error: 'Races are not running' };
    const parsed = RaceSpec.safeParse(candidate);
    if (!parsed.success) return { ok: false, error: configIssueMessage(parsed.error) };
    const spec = parsed.data;
    const refusal = refusalOf(spec);
    if (refusal) return { ok: false, error: refusal };
    return races.start(spec, (contestant, race) => launchContestant(spec, contestant, race, permissions));
  }

  return { start, machineDefaultPermissions };
}

export { CONTESTANT_PROMPT_TIMEOUT_MS, createRaceLauncher };
export type { RaceLauncher };
