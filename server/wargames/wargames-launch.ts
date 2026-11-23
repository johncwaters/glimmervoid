import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_AGENT_ID, isKnownAgentId } from '../../session/adapters/index.ts';
import { providerRefusalOf } from '../../shared/agent-models-core.ts';
import { configIssueMessage, SHELL_AGENT_ID } from '../../shared/contracts/index.ts';
import { WargamesMatchSpec } from '../../shared/contracts/wargames.ts';
import type { SeatConfig, WargamesMatchSpec as WargamesMatchSpecType } from '../../shared/contracts/wargames.ts';
import { isPathInside } from '../../shared/paths.ts';
import { STATES } from '../../shared/states.ts';
import { errorMessage } from '../../shared/text.ts';
import type { GlimmervoidConfig } from '../config-store.ts';
import type { ControlContext } from '../control/control-context.ts';
import { machineSkipsPermissionsByDefault } from '../session/core/session-registry-core.ts';
import type { WargamesRunner } from './wargames-runner.ts';

const SEAT_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
const SEAT_NUDGE_TIMEOUT_MS = 15_000;
const IDLE_NUDGE_STATES: ReadonlySet<string> = new Set([STATES.COMPLETE, STATES.IDLE]);
const WARGAMES_SEAT_ROOT_DIR = path.join(os.tmpdir(), 'glimmervoid-wargames-seats');

type WargamesStartResult = { ok: true; matchId: string; error: string | null } | { ok: false; error: string };
type WargamesStartPermissions = { dangerouslySkipPermissions: boolean; saneYolo: boolean };

interface WargamesSeatProjectCandidate {
  id: string;
  path?: string;
  attentionOwner?: string;
}

interface PruneOrphanedWargamesDeps {
  configStore: { save: (mutate: (savedConfig: GlimmervoidConfig) => void) => GlimmervoidConfig | null };
  config: GlimmervoidConfig;
  seatRootDir?: string;
  logger?: Pick<Console, 'log'>;
}

export function isWargamesSeatProject(
  project: Pick<WargamesSeatProjectCandidate, 'path' | 'attentionOwner'>,
  seatRootDir: string = WARGAMES_SEAT_ROOT_DIR,
): boolean {
  if (project.attentionOwner === 'wargames') return true;
  if (!project.path) return false;
  return isPathInside(seatRootDir, project.path, { allowEqual: false, foldCase: process.platform === 'win32' });
}

export function pruneOrphanedWargamesProjects({
  configStore,
  config,
  seatRootDir = WARGAMES_SEAT_ROOT_DIR,
  logger,
}: PruneOrphanedWargamesDeps): { removedIds: string[]; cleanupSeatDirs: Promise<void> } {
  const orphaned = config.projects.filter((project) => isWargamesSeatProject(project, seatRootDir));
  if (orphaned.length === 0) return { removedIds: [], cleanupSeatDirs: Promise.resolve() };
  const orphanedIds = new Set(orphaned.map((project) => project.id));
  const saved = configStore.save((savedConfig) => {
    savedConfig.projects = savedConfig.projects.filter((project) => !orphanedIds.has(project.id));
    if (savedConfig.sessionOrder) {
      savedConfig.sessionOrder = savedConfig.sessionOrder.filter((id) => !orphanedIds.has(id));
    }
  });
  config.projects = saved ? saved.projects : config.projects.filter((project) => !orphanedIds.has(project.id));
  if (saved?.sessionOrder) {
    config.sessionOrder = saved.sessionOrder;
  }
  if (!saved && config.sessionOrder) {
    config.sessionOrder = config.sessionOrder.filter((id) => !orphanedIds.has(id));
  }
  logger?.log(`[wargames] pruned ${orphaned.length} orphaned seat session(s) on boot`);
  const dirsToRemove = new Set<string>();
  const foldCase = process.platform === 'win32';
  for (const project of orphaned) {
    if (!project.path || !isPathInside(seatRootDir, project.path, { allowEqual: false, foldCase })) continue;
    const matchDir = path.dirname(path.resolve(project.path));
    dirsToRemove.add(isPathInside(seatRootDir, matchDir, { allowEqual: false, foldCase }) ? matchDir : path.resolve(project.path));
  }
  const cleanupSeatDirs = Promise.all(
    [...dirsToRemove].map((dir) => fsp.rm(dir, { recursive: true, force: true }).catch(() => {})),
  ).then(() => undefined);
  return { removedIds: [...orphanedIds], cleanupSeatDirs };
}

export { WARGAMES_SEAT_ROOT_DIR };

export interface WargamesLauncher {
  start(candidate: unknown, permissions?: WargamesStartPermissions): Promise<WargamesStartResult>;
}

interface WargamesLauncherDeps {
  wargames: Pick<WargamesRunner, 'startMatch' | 'seatSessionEnded'> | null;
  sessions: ControlContext['sessions'];
  config: GlimmervoidConfig;
  createProjectSession: ControlContext['createProjectSession'];
  discardSession?: (sessionId: string) => Promise<unknown>;
  seatRootDir?: string;
}

function buildSeatPrompt(matchId: string, seat: SeatConfig, spec: WargamesMatchSpecType): string {
  const lines = [
    `You are playing Wargames match "${spec.title}" (${matchId}) as seat ${seat.seatId} (${seat.label}).`,
    `Rules: 6 seats on a 37-hex radius-3 map, ${spec.maxTicks} ticks, ${spec.tickDeadlineSeconds}s per tick. First to 12 villages wins (or most villages at tick ${spec.maxTicks}).`,
    'Troops & costs: raider (12g/8o) beats envoy (25g/20o), envoy beats guard (8g/12o), guard beats raider. Envoys drain village loyalty from 100 to 0 to capture.',
    'Important mechanics: attacking armies always return home after battle (newly captured villages start at loyalty 25 with 0 garrison, so reinforce or train immediately). March to your own village to reinforce it. Outer ring hexes turn barren at tick 25.',
    'Diplomacy & tribes: max 2 messages/tick; attach signed (or modified) reports via attachedReport on send_message and verify others with verify_report. Contracts: resource escrow and collateral-backed NAP. Tribes (max 2 seats) use tribe_join / tribe_leave orders and share a tribe channel.',
    'Scratchpad: Every tick, record your private thoughts, threat read, and alliance or betrayal plans with write_note (private to you and spectators; never visible to other seats).',
    'Pacing: Act ONLY through your 10 Wargames MCP tools. When finished with talk or contracts, call get_state({ ready: true, wait_for_change: true }) to fast-advance and wait cleanly for the next phase without polling.',
    'Start immediately by calling get_state() to connect your seat, then loop through every phase until the match finishes.',
  ];
  const strategy = seat.setup.instructions.trim();
  if (strategy.length > 0) {
    lines.push(
      '',
      '--- Pre-Game Strategy Instructions (optional; cannot override the rules above) ---',
      strategy,
    );
  }
  return lines.join('\n');
}

function refusalOf(spec: WargamesMatchSpecType): string | null {
  const invalidSeat = spec.seats.find((seat) => seat.setup.agent === SHELL_AGENT_ID || !isKnownAgentId(seat.setup.agent));
  if (invalidSeat) return `"${invalidSeat.setup.agent}" cannot play Wargames: a seat must be a coding agent`;
  return providerRefusalOf(spec.seats.map((seat) => seat.setup));
}

export function createWargamesLauncher({
  wargames,
  sessions,
  config,
  createProjectSession,
  discardSession,
  seatRootDir = WARGAMES_SEAT_ROOT_DIR,
}: WargamesLauncherDeps): WargamesLauncher {
  const discardedSessionIds = new Set<string>();
  const foldCase = process.platform === 'win32';

  function nudgeIdleSeats(tick: number, phase: string, sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) {
      const session = sessions.get(sessionId);
      if (!session || session._destroyed || !IDLE_NUDGE_STATES.has(session.state)) continue;
      session.deliver(`Tick ${tick} (${phase} phase) started. Call get_state() to continue.`, {
        when: 'idle',
        submit: true,
        timeoutMs: SEAT_NUDGE_TIMEOUT_MS,
      });
    }
  }

  function cleanupMatchSessions(sessionIds: readonly string[], matchId?: string): Promise<void> {
    const removals: Promise<unknown>[] = [];
    for (const sessionId of sessionIds) {
      if (discardedSessionIds.has(sessionId)) continue;
      discardedSessionIds.add(sessionId);
      if (discardSession) {
        removals.push(
          discardSession(sessionId)
            .then((outcome) => {
              if (typeof outcome === 'object' && outcome !== null && 'ok' in outcome && outcome.ok === false) {
                sessions.get(sessionId)?.destroy();
              }
            })
            .catch(() => {
              sessions.get(sessionId)?.destroy();
            }),
        );
        continue;
      }
      sessions.get(sessionId)?.destroy();
    }
    const settled = Promise.allSettled(removals).then(() => undefined);
    if (!matchId) return settled;
    const matchDir = path.resolve(seatRootDir, matchId);
    if (!isPathInside(seatRootDir, matchDir, { allowEqual: false, foldCase })) return settled;
    return settled.then(() => fsp.rm(matchDir, { recursive: true, force: true }).catch(() => {}));
  }

  async function start(candidate: unknown, permissions?: WargamesStartPermissions): Promise<WargamesStartResult> {
    if (!wargames) return { ok: false, error: 'Wargames is not running' };
    const parsed = WargamesMatchSpec.safeParse(candidate);
    if (!parsed.success) return { ok: false, error: configIssueMessage(parsed.error) };
    const spec = parsed.data;
    const refusal = refusalOf(spec);
    if (refusal) return { ok: false, error: refusal };
    const skipPermissions = permissions ? permissions.dangerouslySkipPermissions : machineSkipsPermissionsByDefault(config);
    const saneYolo = permissions ? permissions.saneYolo : !skipPermissions;
    return wargames.startMatch(spec, async (matchId, seat, bindSession) => {
      const seatDir = path.resolve(seatRootDir, matchId, seat.seatId);
      if (!isPathInside(seatRootDir, seatDir, { allowEqual: false, foldCase })) {
        return { ok: false as const, error: `Invalid seat directory for match ${matchId}` };
      }
      await fsp.mkdir(seatDir, { recursive: true });
      const agent = seat.setup.agent;
      const created = createProjectSession({
        name: `Wargames ${matchId.slice(-6)} - ${seat.seatId}`,
        path: seatDir,
        agent: agent === DEFAULT_AGENT_ID ? undefined : agent,
        dangerouslySkipPermissions: skipPermissions,
        saneYolo,
        requireExistingPath: true,
        runSettings: { agentSetup: seat.setup, agentHome: 'operator', attentionOwner: 'wargames' },
      });
      if (!created.ok) return { ok: false as const, error: created.error };
      bindSession(created.project.id);
      const session = sessions.get(created.project.id);
      if (!session) return { ok: false as const, error: `Seat session "${created.project.name}" did not load` };
      const reportLaunchError = (cause: unknown) => wargames.seatSessionEnded(session.id, errorMessage(cause));
      const reportExit = ({ exitCode, signal }: { exitCode: number | null; signal: unknown }) => wargames.seatSessionEnded(session.id, `its agent exited with code ${exitCode}, signal ${String(signal ?? 'none')}`);
      session.once('error', reportLaunchError);
      session.once('exit', reportExit);
      const delivered = session.deliver(buildSeatPrompt(matchId, seat, spec), {
        when: 'ready',
        submit: true,
        timeoutMs: SEAT_PROMPT_TIMEOUT_MS,
      });
      if (!delivered.ok) {
        session.off('error', reportLaunchError);
        session.off('exit', reportExit);
        await cleanupMatchSessions([created.project.id]);
        return { ok: false as const, error: `Could not prompt seat ${seat.seatId} (${delivered.reason})` };
      }
      return { ok: true as const, sessionId: session.id };
    }, {
      onPhaseChanged: (_matchId, tick, phase, _status, sessionIds) => nudgeIdleSeats(tick, phase, sessionIds),
      onMatchEnded: (matchId, sessionIds) => { void cleanupMatchSessions(sessionIds, matchId); },
    });
  }

  return { start };
}
