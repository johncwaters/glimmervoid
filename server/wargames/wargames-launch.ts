import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_AGENT_ID, isKnownAgentId } from '../../session/adapters/index.ts';
import { removeEveryPrivateAgentHome, removePrivateAgentHomes } from '../../session/agent-home.ts';
import { providerRefusalOf } from '../../shared/agent-models-core.ts';
import { configIssueMessage, SHELL_AGENT_ID } from '../../shared/contracts/index.ts';
import { WargamesMatchSpec, foundCostFor, troopCostsFor, valueForRadius, WARGAMES_TRAVEL_HEXES_PER_TICK, victoryPointTargetFor, WARGAMES_BALANCE } from '../../shared/contracts/wargames.ts';
import { projectSeatState, terrainOf } from '../../shared/wargames/engine.ts';
import type { MatchState } from '../../shared/wargames/engine.ts';
import { FOREST_DEFENSE_MULTIPLIER, marchCostOf } from '../../shared/wargames/terrain.ts';
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

function costText(cost: { grain: number; ore: number }): string {
  return `${cost.grain} grain / ${cost.ore} ore`;
}

function winLines(spec: WargamesMatchSpecType): string[] {
  const { victory, territory } = WARGAMES_BALANCE;
  const target = victoryPointTargetFor(WARGAMES_BALANCE, spec.mapRadius, spec.seats.length);
  return [
    'How to win',
    `- Victory points (VP) decide the match. At the end of every tick you score 1 VP per village you hold, 1 VP per ${territory.tilesPerPoint} land hexes you hold, and ${victory.beaconPoints} VP per Beacon you hold with a troop inside. VP are never lost.`,
    `- The first seat to ${target} VP wins; otherwise the most VP after tick ${spec.maxTicks} wins (ties: more villages, then more income).`,
    `- Land is the cheapest VP: ${territory.tilesPerPoint} land hexes score as much as a village, with no battle. You start owning the open hexes around your villages. To claim another, march 1 troop to an open hex touching your land; once it has stood there through the next tick, the hex is yours (at most ${territory.claimsPerVillagePerTurn} new hex per village you hold each tick; an enemy army standing there blocks it).`,
    '- get_state yourLand lists your land, its VP per tick, the hexes you can claim next, and a claim march and a build order you can submit as written.',
  ];
}

function turnLines(spec: WargamesMatchSpecType): string[] {
  return [
    'Each tick',
    `- ${spec.tickDeadlineSeconds}s in two phases. Talk: read_messages, send_message, then get_state({ ready: true, wait_for_change: true }). Orders: one submit_orders call; every seat's orders resolve together.`,
    '- Start with get_state() and act only through your Wargames tools. get_reports holds your battle and land reports. write_note keeps private plans.',
    '- Every seat sees the whole board: every village with its troops and Wall, all land, and every army in the field. Only direct messages and notes are private. get_state otherSeats lists each other seat with how close its border is, when you last messaged each other, and its armies near you or marching at you.',
  ];
}

function orderLines(spec: WargamesMatchSpecType): string[] {
  const { roles, buildingCosts, territory } = WARGAMES_BALANCE;
  const troopCosts = troopCostsFor(WARGAMES_BALANCE);
  const { field, quarry, outpost } = territory.improvements;
  const unitText = (troop: 'raider' | 'guard' | 'envoy') => `${troop} ${roles.units[troop].attack}/${roles.units[troop].defense} for ${costText(troopCosts[troop])}`;
  return [
    'Orders (submit_orders({ orders: [...] }); hexIndex values come from get_state)',
    `- train { "kind": "train", "hexIndex": 12, "troop": "guard", "count": 5 }: in your village, paid from its stock. Attack/defense: ${unitText('raider')}, ${unitText('guard')}, ${unitText('envoy')}. A village holds ${roles.troopCapBase} troops plus ${roles.troopCapPerFarmLevel} per Farm level, counting its armies out.`,
    `- build { "kind": "build", "hexIndex": 12, "building": "wall" }: one build per hex per tick. In a village, up to level 10: farm (${costText(buildingCosts.farm)}, +20 grain and +200 storage per level), mine (${costText(buildingCosts.mine)}, +20 ore and +200 storage), wall (${costText(buildingCosts.wall)}, +${roles.wallDefensePerLevel} defense and +${Math.round(roles.wallBonusPerLevel * 100)}% defense power). On your land, paid by your nearest village: field (${costText(field.cost)}, up to level ${field.maxLevel}, +${field.yieldPerLevel} grain per level to a village next to it, +${territory.tileBonusPerLevel} on Fertile), quarry (${costText(quarry.cost)}, up to level ${quarry.maxLevel}, +${quarry.yieldPerLevel} ore per level, +${territory.tileBonusPerLevel} on Ore), outpost (${costText(outpost.cost)}, level ${outpost.maxLevel} only, your armies on it defend at +${Math.round(territory.outpostDefenseBonus * 100)}%). A village makes 25 grain and 25 ore per tick and stores 500 of each.`,
    `- march { "kind": "march", "fromHexIndex": 12, "toHexIndex": 30, "troops": { "raider": 6, "guard": 0, "envoy": 2 } }: ${WARGAMES_TRAVEL_HEXES_PER_TICK} hexes per tick along the cheapest path (Forest costs ${marchCostOf('forest')}; Mountain and Lake block). To an open hex the army stays standing until ordered on, from that hex. To your own village it reinforces.`,
    `- found { "kind": "found", "hexIndex": 40 }: turns a bare land hex at least ${territory.foundSpacing} hexes from any village or Beacon into a village with ${WARGAMES_BALANCE.capturedLoyalty} Loyalty. Your nearest village pays ${territory.foundEnvoys} Envoys and ${costText(foundCostFor(territory, 0))}, rising with each founding; at most ${valueForRadius(territory.foundLimitByRadius, spec.mapRadius)} on this map.`,
  ];
}

function combatLines(): string[] {
  const balance = WARGAMES_BALANCE;
  const roles = balance.roles;
  return [
    'Combat',
    `- Attack is the attack of your troops; defense is (the troops' defense plus the Wall) times the Wall bonus, times ${FOREST_DEFENSE_MULTIPLIER} on Forest. The higher side wins (attack varies ${Math.round(roles.attackVariance * 100)}%); the loser is wiped and the winner loses troops in proportion, then goes home unless it captured. A beaten attack still kills defenders, and losses stick. Armies on land fight armies that march onto them, with no Wall.`,
    `- Capture: each surviving Envoy drains ${roles.captureDrainMin} to ${roles.captureDrainMax} Loyalty once the defense is beaten or the village has no troops left (a Wall alone does not stop Envoys); an Envoy-only army at a defended village is wiped. At 0 Loyalty the village is yours with ${balance.capturedLoyalty} Loyalty, your survivors, and ${Math.round(balance.captureRazeFraction * 100)}% of each building razed. Owned villages regain ${balance.loyaltyRegenPerTurn} Loyalty per tick; unowned ones grow ${balance.barbarianGuardGrowthPerTurn} Guard per tick up to ${balance.barbarianGuardCap}.`,
    `- Morale: attacking a seat with fewer VP, you fight at the square root of (their VP / yours), never below ${Math.round(roles.moraleFloor * 100)}%; full while you have under ${roles.moraleMinAttackerPoints} VP.`,
    '- Seats attacking one hex in the same tick fight each other too; only the strongest can take it.',
  ];
}

function diplomacyLines(): string[] {
  return [
    'Diplomacy',
    '- Talk is a direct message to one seat or a public message every seat reads.',
    '- Agreements are words only: nothing enforces a promise, and any seat may attack any other at any time.',
    '- Seats can still work together across turns: one clears a village\'s defenders this tick, another captures it the next.',
    '- Talk wins villages: seats that agree to take turns on a village take it, and a seat that stays quiet is the easy target its neighbors pick.',
    '- A public message reaches every seat at once, which suits a warning or an accusation.',
  ];
}

type SeatView = ReturnType<typeof projectSeatState>;

function lastSpokeText(seatId: string, lastMessageToTick: number | null): string {
  return lastMessageToTick === null ? `you have never messaged ${seatId}` : `you have not messaged ${seatId} since tick ${lastMessageToTick}`;
}

function threatLineOf(view: SeatView): string | null {
  const yourVillageHexes = new Set(view.yourVillages.map((village) => village.hexIndex));
  const yourLandHexes = new Set(view.land.bySeat[view.yourSeatId] ?? []);
  const threats = view.otherSeats.flatMap((other) => other.armiesNearYou
    .filter((army) => army.turnsToArrive !== null && (yourVillageHexes.has(army.target) || yourLandHexes.has(army.target)))
    .map((army) => ({ other, army })));
  const biggest = threats.sort((left, right) => right.army.troops - left.army.troops)[0];
  if (!biggest) return null;
  const { other, army } = biggest;
  const targetText = yourVillageHexes.has(army.target) ? `your village ${army.target}` : `your land ${army.target}`;
  const turnsText = army.turnsToArrive === 1 ? 'next turn' : `in ${army.turnsToArrive} turns`;
  return `Seat ${other.seatId} has ${army.troops} troops marching at ${targetText}, arriving ${turnsText}, and ${lastSpokeText(other.seatId, other.lastMessageToTick)}.`;
}

const BORDERING_HEXES = 3;

function silenceLineOf(view: SeatView): string | null {
  const reachable = view.otherSeats.filter((other) => other.status !== 'eliminated' && other.borderDistance !== null);
  const bordering = reachable.filter((other) => (other.borderDistance ?? Number.POSITIVE_INFINITY) <= BORDERING_HEXES);
  const pool = bordering.length > 0 ? bordering : reachable;
  const quietest = [...pool].sort((left, right) => (left.lastMessageToTick ?? -1) - (right.lastMessageToTick ?? -1)
    || (left.borderDistance ?? 0) - (right.borderDistance ?? 0))[0];
  if (!quietest) return null;
  const distanceText = quietest.borderDistance === 1 ? '1 hex' : `${quietest.borderDistance} hexes`;
  return `Seat ${quietest.seatId}'s border is ${distanceText} from yours and ${lastSpokeText(quietest.seatId, quietest.lastMessageToTick)}.`;
}

function phaseNudgeOf(state: MatchState, seatId: SeatConfig['seatId']): string {
  const opening = `Tick ${state.tick} (${state.phase} phase) started. Call get_state() to continue.`;
  if (state.phase === 'orders') return `${opening} When get_state yourLand.examples.claim is present, it is a claim order you can submit as written.`;
  if (state.phase !== 'talk') return opening;
  const view = projectSeatState(state, seatId);
  const prompt = threatLineOf(view) ?? silenceLineOf(view);
  return prompt === null ? opening : `${opening} ${prompt}`;
}

function terrainLine(spec: WargamesMatchSpecType): string[] {
  if (terrainOf(spec).every((kind) => kind === 'plain')) return [];
  return ['- Terrain (get_state terrain): Mountain and Lake block marches, Forest slows them and defends better, Fertile and Ore raise a Field or Quarry built on them. It is the same around every seat.'];
}

function buildSeatPrompt(matchId: string, seat: SeatConfig, spec: WargamesMatchSpecType): string {
  const lines = [
    `You are seat ${seat.seatId} (${seat.label}) in Wargames match "${spec.title}" (${matchId}).`,
    '',
    ...winLines(spec),
    '',
    ...turnLines(spec),
    '',
    ...orderLines(spec),
    ...terrainLine(spec),
    '',
    ...combatLines(),
    '',
    ...diplomacyLines(),
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

  function nudgeIdleSeats(state: MatchState, seatSessions: readonly { sessionId: string; seatId: SeatConfig['seatId'] }[]): void {
    for (const { sessionId, seatId } of seatSessions) {
      const session = sessions.get(sessionId);
      if (!session || session._destroyed || !IDLE_NUDGE_STATES.has(session.state)) continue;
      session.deliver(phaseNudgeOf(state, seatId), {
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
      onPhaseChanged: nudgeIdleSeats,
      onMatchEnded: (matchId, sessionIds) => { void cleanupMatchSessions(sessionIds, matchId); },
    });
  }

  return { start };
}
