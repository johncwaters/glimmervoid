import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_AGENT_ID, isKnownAgentId } from '../../session/adapters/index.ts';
import { removeEveryPrivateAgentHome, removePrivateAgentHomes } from '../../session/agent-home.ts';
import { providerRefusalOf } from '../../shared/agent-models-core.ts';
import { configIssueMessage, SHELL_AGENT_ID } from '../../shared/contracts/index.ts';
import { WargamesMatchSpec, victoryVillagesFor } from '../../shared/contracts/wargames.ts';
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
const SEAT_PROJECT_MCP_FILE_NAME = '.mcp.json';
const SEAT_PROJECT_MCP_FILE_TEXT = '{"mcpServers":{}}\n';

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
  logger?: Pick<Console, 'log' | 'warn'>;
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
  const privateHomesRemoved = removeEveryPrivateAgentHome().then((failures) => {
    for (const failure of failures) logger?.warn(`[wargames] ${failure}`);
  });
  if (orphaned.length === 0) return { removedIds: [], cleanupSeatDirs: privateHomesRemoved };
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
  ).then(() => privateHomesRemoved);
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
  const winVillages = victoryVillagesFor(spec);
  const lines = [
    `You are playing Wargames match "${spec.title}" (${matchId}) as seat ${seat.seatId} (${seat.label}).`,
    '',
    '=== WARGAMES RULEBOOK ===',
    `Objective & Clock: ${spec.maxTicks} ticks (${spec.tickDeadlineSeconds}s per tick). First seat to hold ${winVillages} villages wins; otherwise the seat with the most villages after tick ${spec.maxTicks} wins.`,
    '',
    'Units & Combat (1.5x Counter Bonus):',
    '- Raider (12 grain / 8 ore, base power 10): deals 1.5x power (15) if the opposing force has any Envoys.',
    '- Guard (8 grain / 12 ore, base power 10): deals 1.5x power (15) if the opposing force has any Raiders.',
    '- Envoy (25 grain / 20 ore, base power 8): deals 1.5x power (12) if the opposing force has any Guards. Required to capture villages.',
    '- Movement & Battles: Armies travel 2 hexes per tick. March to your own village to reinforce it. Combat is simultaneous with +/-10% attack variance; the losing side is wiped and the winner takes proportional casualties. When you win a battle and capture a village, your surviving army stays there as its new garrison. If you win a battle without capturing (Loyalty still above 0), survivors return home.',
    '',
    'Loyalty & Capturing Villages:',
    '- Every village starts at 100 Loyalty. Winning a battle without surviving Envoys wipes the defenders but does not capture the village.',
    '- Each surviving Envoy drains 35 Loyalty (3 surviving Envoys drop a 100-Loyalty village to 0 in one battle).',
    '- When Loyalty hits 0, the village flips to you at 25 Loyalty with your surviving attackers as its garrison. Because it starts at 25 Loyalty, a single surviving enemy Envoy can flip it back if you lose a defense there.',
    '',
    'Economy & Buildings (max level 10, 1 build per village per tick):',
    '- Base village: produces 25 grain and 25 ore per tick (500 base storage cap).',
    '- Farm (40 grain / 30 ore): +20 grain/tick and +200 storage cap per level.',
    '- Mine (30 grain / 40 ore): +20 ore/tick and +200 storage cap per level.',
    '- Wall (30 grain / 60 ore): +15% defender combat power per level.',
    '- Barracks (50 grain / 50 ore): military infrastructure upgrade (training is instant and bounded by grain and ore).',
    '',
    'Diplomacy, Contracts & Tribes:',
    '- Messages: Send direct or tribe messages during Talk. Attach signed battle or scout reports (or forged copies) via attachedReport on send_message, and check authenticity with verify_report.',
    '- Scouting: Up to 2 scouts per tick to reveal enemy garrisons, buildings, and marching armies.',
    '- Contracts: Propose a Resource Escrow (atomic grain/ore swap) or a Non-Aggression Pact (NAP), where both seats lock collateral resources for N ticks. Attacking your NAP partner breaches the pact, forfeits your collateral to the victim, and records the breach on the public ledger.',
    '- Tribes: Up to 2 seats may form a tribe via tribe_join / tribe_leave orders to share a private tribe channel.',
    '',
    'Private Notes:',
    '- Every tick, record your private thoughts, threat read, and alliance or betrayal plans with write_note (private to your seat; never visible to other seats).',
    '',
    'Turn Loop & Pacing:',
    '- Act ONLY through your 10 Wargames MCP tools. Start immediately by calling get_state() to connect your seat, then loop through Talk, Contracts, and Orders until the match finishes.',
    '- When finished with Talk or Contracts, call get_state({ ready: true, wait_for_change: true }) to fast-advance and wait cleanly for the next phase without polling.',
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

const PRIVATE_HOME_SEAT_AGENT_IDS: ReadonlySet<string> = new Set(['claude-code', 'codex', 'kimi', 'antigravity']);

function refusalOf(spec: WargamesMatchSpecType): string | null {
  const invalidSeat = spec.seats.find((seat) => seat.setup.agent === SHELL_AGENT_ID || !isKnownAgentId(seat.setup.agent));
  if (invalidSeat) return `"${invalidSeat.setup.agent}" cannot play Wargames: a seat must be a coding agent`;
  const sharedHomeSeat = spec.seats.find((seat) => !PRIVATE_HOME_SEAT_AGENT_IDS.has(seat.setup.agent));
  if (sharedHomeSeat) return `"${sharedHomeSeat.setup.agent}" cannot play Wargames yet: its sessions share one agent home, so a seat could read another seat or play under your own instructions`;
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
    const settled = Promise.allSettled(removals).then(async () => {
      const failures = (await Promise.all(sessionIds.map((sessionId) => removePrivateAgentHomes(sessionId)))).flat();
      for (const failure of failures) console.warn(`[wargames] ${failure}`);
    });
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
      await fsp.writeFile(path.join(seatDir, SEAT_PROJECT_MCP_FILE_NAME), SEAT_PROJECT_MCP_FILE_TEXT);
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
