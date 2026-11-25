import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_AGENT_ID, isKnownAgentId } from '../../session/adapters/index.ts';
import { removeEveryPrivateAgentHome, removePrivateAgentHomes } from '../../session/agent-home.ts';
import { providerRefusalOf } from '../../shared/agent-models-core.ts';
import { configIssueMessage, SHELL_AGENT_ID } from '../../shared/contracts/index.ts';
import { ArmyStatus, ImprovementKind, WargamesMatchSpec, foundCostFor, troopCostsFor, valueForRadius, WARGAMES_TRAVEL_HEXES_PER_TICK, victoryPointTargetFor, WARGAMES_BALANCE } from '../../shared/contracts/wargames.ts';
import { terrainOf } from '../../shared/wargames/engine.ts';
import { FOREST_DEFENSE_MULTIPLIER, marchCostOf } from '../../shared/wargames/terrain.ts';
import type { SeatConfig, WargamesBalance, WargamesMatchSpec as WargamesMatchSpecType, WargamesTerritoryRule } from '../../shared/contracts/wargames.ts';
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

function victoryPointLine(spec: WargamesMatchSpecType, clock: string): string {
  const balance = WARGAMES_BALANCE;
  const victory = balance.victory;
  const target = victoryPointTargetFor(balance, spec.mapRadius, spec.seats.length);
  const landRule = ` plus 1 VP per ${balance.territory.tilesPerPoint} land hexes it holds,`;
  return [
    `${clock} Victory points (VP) decide the match. At the end of every tick each seat gains 1 VP per village it holds and ${victory.beaconPoints} VP per Beacon it holds with at least 1 troop inside,${landRule} and VP are never lost.`,
    ...landObjectiveLines(balance.territory),
    `The first seat to reach ${target} VP wins; otherwise the seat with the most VP after tick ${spec.maxTicks} wins (ties: more villages, then more income). get_state shows every seat's VP in victoryPointsBySeat and the target in victoryPointTarget.`,
    'Beacons are the sites with isBeacon true in get_state sites: they produce nothing and cannot be built on; capture them like a village, and a Beacon left with no troops goes back to unowned at the end of the tick. get_state sites lists every village and Beacon on the map, even ones you cannot see into.',
  ].join(' ');
}

function landObjectiveLines(territory: WargamesTerritoryRule): string[] {
  const { tilesPerPoint, tileBonusPerLevel } = territory;
  const { field, quarry } = territory.improvements;
  return [
    `Land wins matches: you start owning every open hex next to your villages, and every ${tilesPerPoint} land hexes score 1 VP per tick, as much as a whole village, with no battle. ${tilesPerPoint * 3} land hexes score 3 VP every tick.`,
    'Claim more: march 1 troop to an open hex touching your land; once it has stood there through the next tick, the hex is yours. A village you capture or found brings the unowned open hexes around it.',
    `Improve land: a Field on land next to your village adds ${field.yieldPerLevel} grain per tick per level (${field.yieldPerLevel + tileBonusPerLevel} on a Fertile hex), a Quarry ${quarry.yieldPerLevel} ore (${quarry.yieldPerLevel + tileBonusPerLevel} on an Ore deposit); more income trains more troops.`,
    'get_state yourLand shows your land count, land VP per tick, the hexes you can claim next and what each suits, and in examples a claim march and a build order you can submit as written.',
  ];
}

function objectiveLine(spec: WargamesMatchSpecType): string {
  return victoryPointLine(spec, `Objective & Clock: ${spec.maxTicks} ticks (${spec.tickDeadlineSeconds}s per tick).`);
}

const MOVEMENT_LINE = `- Movement & Battles: Armies travel ${WARGAMES_TRAVEL_HEXES_PER_TICK} hexes per tick along the cheapest path; a forest hex costs ${marchCostOf('forest')} of that, and mountains and lakes are walked around. A far target takes several ticks, so plan marches that many ticks ahead. March to your own village to reinforce it. Combat is simultaneous with +/-10% attack variance; the losing side is wiped and the winner takes proportional casualties. When you win a battle and capture a village, your surviving army stays there as its new garrison. If you win a battle without capturing (Loyalty still above 0), survivors return home.`;

function unitLines(): string[] {
  const balance = WARGAMES_BALANCE;
  const roles = balance.roles;
  const costs = troopCostsFor(balance);
  const unitLine = (label: string, troop: 'raider' | 'guard' | 'envoy', role: string) => {
    const unit = roles.units[troop];
    return `- ${label} (${costs[troop].grain} grain / ${costs[troop].ore} ore): attack ${unit.attack}, defense ${unit.defense}. ${role}`;
  };
  const floorPercent = Math.round(roles.moraleFloor * 100);
  return [
    'Units & Combat (attack and defense are separate; defending is cheaper than attacking):',
    unitLine('Raider', 'raider', 'Attacks; weak when it has to defend.'),
    unitLine('Guard', 'guard', 'Defends; weak in an attack.'),
    unitLine('Envoy', 'envoy', 'Never attacks; adds its defense in a garrison; captures villages (see Loyalty).'),
    '- Attack power is the attack of every troop you send. Defense power is (the defense of every troop in the village, allied guests included, plus the Wall) times the Wall bonus and any terrain or last-village multiplier. The stronger side wins.',
    MOVEMENT_LINE,
    `- Morale: when you attack a seat with fewer VP than you, your troops fight at the square root of (their VP / your VP), never below ${floorPercent}%. Morale is full while you have under ${roles.moraleMinAttackerPoints} VP and against Barbarians.`,
    `- Troop cap: a village holds at most ${roles.troopCapBase} + ${roles.troopCapPerFarmLevel} per Farm level troops, counting its own troops, allied guests and its troops out on the march. Training stops at the cap; troops arriving past it march back home.`,
    `- Joint attacks: per grain and ore spent, a Guard buys about ${defensePerAttack(roles, costs)}x the defense that a Raider buys in attack, and the Wall adds more, so one seat alone cannot break a guarded village it matched in spending. Two allies can: in the same tick both march on the same hex, one with a plain march and the other with support: <that seat>. To lend Guards to an ally, march them to the ally's village with support: <ally>.`,
  ];
}

function defensePerAttack(roles: WargamesBalance['roles'], costs: ReturnType<typeof troopCostsFor>): string {
  const totalCost = (troop: 'raider' | 'guard') => costs[troop].grain + costs[troop].ore;
  const ratio = (roles.units.guard.defense / totalCost('guard')) / (roles.units.raider.attack / totalCost('raider'));
  return ratio.toFixed(1);
}

function captureLines(): string[] {
  const balance = WARGAMES_BALANCE;
  const roles = balance.roles;
  return [
    '- Every village starts at 100 Loyalty. Capture is a separate wave: an army of only Envoys never fights, and Envoys drain Loyalty only once the village\'s defense is beaten this tick (your attack, or an ally supporting it, beat its troops and Wall), or it has no troops and no Wall.',
    `- Each surviving Envoy drains a random ${roles.captureDrainMin} to ${roles.captureDrainMax} Loyalty. Envoys marching with Raiders die with them in proportion; an Envoy-only army arriving at a defended village, or with a side that lost, is wiped.`,
  ];
}

function loyaltyLines(): string[] {
  const balance = WARGAMES_BALANCE;
  const lines = [
    ...captureLines(),
    `- When Loyalty hits 0, the village flips to you at ${balance.capturedLoyalty} Loyalty with your surviving attackers as its garrison.`,
  ];
  if (balance.loyaltyRegenPerTurn > 0) lines.push(`- Every village you own regains ${balance.loyaltyRegenPerTurn} Loyalty per tick, up to 100, so a fresh capture hardens over a few ticks.`);
  if (balance.captureRazeFraction > 0) lines.push(`- Capturing a village destroys ${Math.round(balance.captureRazeFraction * 100)}% of each building's levels (rounded up), so buildings are worth more to the seat that built them than to a raider.`);
  if (balance.barbarianGuardGrowthPerTurn > 0) lines.push(`- Unowned villages gain ${balance.barbarianGuardGrowthPerTurn} Guard per tick, up to ${balance.barbarianGuardCap}, so late expansion costs more.`);
  return lines;
}

function terrainLines(spec: WargamesMatchSpecType): string[] {
  const hasTerrain = terrainOf(spec).some((kind) => kind !== 'plain');
  if (!hasTerrain) return [];
  return [
    '',
    'Terrain (get_state lists every non-plain hex in terrain):',
    '- Mountain and Lake hexes are impassable and hold no village; armies march around them, so they make fronts and chokepoints.',
    `- Forest costs 2 of an army's 2 hexes of movement per tick to enter, and a village on Forest defends at ${FOREST_DEFENSE_MULTIPLIER}x power.`,
    '- A Fertile hex raises a Field built on it, and an Ore deposit a Quarry built on it (see Improvements).',
    '- Terrain is symmetric: every seat faces the same terrain around its home.',
  ];
}

function wallLine(): string {
  const balance = WARGAMES_BALANCE;
  const cost = balance.buildingCosts.wall;
  const roles = balance.roles;
  return `- Wall (${cost.grain} grain / ${cost.ore} ore): each level adds ${roles.wallDefensePerLevel} defense and +${Math.round(roles.wallBonusPerLevel * 100)}% defense power, up to level 10. An attack that clears the defenders knocks the Wall down by at least 1 level, more the larger its margin.`;
}

function buildingLines(): string[] {
  const costs = WARGAMES_BALANCE.buildingCosts;
  return [
    '- Base village: produces 25 grain and 25 ore per tick (500 base storage cap).',
    `- Farm (${costs.farm.grain} grain / ${costs.farm.ore} ore): +20 grain/tick and +200 storage cap per level.`,
    `- Mine (${costs.mine.grain} grain / ${costs.mine.ore} ore): +20 ore/tick and +200 storage cap per level.`,
    wallLine(),
  ];
}

function landLines(spec: WargamesMatchSpecType): string[] {
  const territory = WARGAMES_BALANCE.territory;
  const { field, quarry, watchtower, outpost } = territory.improvements;
  const costText = (cost: { grain: number; ore: number }) => `${cost.grain} grain / ${cost.ore} ore`;
  const firstFoundCost = foundCostFor(territory, 0);
  const secondFoundCost = foundCostFor(territory, 1);
  const foundLimit = valueForRadius(territory.foundLimitByRadius, spec.mapRadius);
  return [
    '',
    'Land, Improvements & Founding (get_state territory lists every land hex with its owner, improvement and level):',
    `- Standing armies: an army that marches to an open hex (no village or Beacon, not Mountain or Lake) stays there, holding it, until you order it on. Order it with a march whose fromHexIndex is that hex; send it to one of your villages to bring it home. It still counts against its home village's troop cap. get_state visibleArmies shows standing armies with status "${ArmyStatus.enum.standing}".`,
    `- Claiming: an army that has held an open hex through the end of a whole tick after the one it arrived in makes that hex your land, if the hex touches land you already hold (one of your villages or your land hexes) and no other seat stands there. Each tick a seat claims at most ${territory.claimsPerVillagePerTurn} new hex per village it holds. When two seats arrive at an empty hex in the same tick, both turn back.`,
    '- Fighting on land: an army that marches onto a hex where another seat\'s army stands attacks it (your attack against their defense times any Forest bonus, no Wall). If the defenders fall, your strongest seat\'s survivors stand there; if not, your army is wiped. Attacking or taking land from a seat you hold a NAP or alliance with breaks the pact, like an attack on a village.',
    `- Land VP: every tick you score 1 VP per ${territory.tilesPerPoint} land hexes you hold. Land produces nothing by itself; improvements do.`,
    `- Improvements: each land hex holds one, built with a build order on that hex (building: ${ImprovementKind.options.map((kind) => `"${kind}"`).join(', ')}). Your nearest village pays from its own stock. Repeat the order to raise the level. One build per hex per tick.`,
    `  - Field (${costText(field.cost)}, up to level ${field.maxLevel}): +${field.yieldPerLevel} grain per tick per level to your nearest village, only while that village is next to the Field, +${territory.tileBonusPerLevel} more per level on a Fertile hex.`,
    `  - Quarry (${costText(quarry.cost)}, up to level ${quarry.maxLevel}): +${quarry.yieldPerLevel} ore per tick per level to your nearest village, +${territory.tileBonusPerLevel} more per level on an Ore deposit hex.`,
    `  - Watchtower (${costText(watchtower.cost)}): armies within ${territory.watchtowerRange} hexes of it show in your get_state visibleArmies.`,
    `  - Outpost (${costText(outpost.cost)}): your armies standing on it defend at +${Math.round(territory.outpostDefenseBonus * 100)}%.`,
    `- When your land is taken, its improvement loses half its levels (rounded up), so a level 1 improvement is destroyed.`,
    `- Founding: a found order ({ kind: "found", hexIndex }) turns one of your land hexes with no improvement into a new village, if no village or Beacon is within ${territory.foundSpacing - 1} hex of it. Your nearest village pays ${territory.foundEnvoys} Envoys and ${costText(firstFoundCost)} for your first, ${costText(secondFoundCost)} for your second, and so on; at most ${foundLimit} per seat on this map. get_state yourVillagesFounded counts yours. A new village starts at ${WARGAMES_BALANCE.capturedLoyalty} Loyalty with no troops, buildings or stock.`,
  ];
}

function supportLine(): string {
  const attackSupport = '- Support: a march order may name support: <seat>. If that seat is your active ally and attacks the same target hex that tick, your troops fight on its side: one combined attack power against the defender, the ally takes the village if it captures, losses are shared in proportion, and your survivors march home.';
  const unsupported = 'With no active alliance, or no ally attack there, the support march turns back without fighting. Two seats that attack one hex without support fight each other too: only the strongest can take it, and the others are wiped.';
  const garrison = 'Sent to the ally\'s own village, your troops stay yours as guests: they defend it with its Wall, count against its troop cap, share its losses, and march home on their own when the alliance ends or breaks.';
  return `${attackSupport} ${garrison} ${unsupported}`;
}

function diplomacyLines(): string[] {
  const shared = [
    '- Scouting: Up to 2 scouts per tick to reveal enemy garrisons, buildings, and marching armies. Orders are sealed and resolve simultaneously, so no seat sees another seat\'s orders before they resolve.',
  ];
  const diplomacy = WARGAMES_BALANCE.diplomacy;
  if (!diplomacy) {
    return [
      '- Messages: Send direct messages during Talk. Attach signed battle or scout reports (or forged copies) via attachedReport on send_message, and check authenticity with verify_report.',
      '- Contracts: Propose a Resource Escrow (atomic grain/ore swap) or a Non-Aggression Pact (NAP), where both seats lock collateral resources for N ticks. Attacking your NAP partner breaches the pact, forfeits your collateral to the victim, and records the breach on the public ledger.',
      ...shared,
    ];
  }
  return [
    '- Messages: Send direct or public messages during Talk; every seat reads the public channel. Attach signed battle or scout reports (or forged copies) via attachedReport on send_message, and check authenticity with verify_report. Talk binds nothing; only contracts are enforced.',
    '- Escrow: an atomic grain/ore swap that settles the moment it is accepted.',
    `- Alliance VP: at the end of every turn an alliance is in force, each partner scores ${diplomacy.allianceVpPerTurn} VP. If one partner breaks it, the victim also scores the breaker's alliance VP for every turn the alliance stood (${diplomacy.allianceVpPerTurn} VP per turn).`,
    '- Alliance: two seats may hold one alliance at a time (one proposed or active). Both seats lock the stated collateral for N ticks. While it is active neither may attack the other, and each may support the other. When it runs its full term both get their collateral back. If one attacks the other, the alliance breaks: the victim takes the attacker\'s collateral and its own back, and the breach goes on the public ledger.',
    supportLine(),
    `- Reputation: get_state shows every seat's record of deals kept (pacts that ran their term, settled escrows) and deals broken (breaches). A seat with B broken deals locks ${diplomacy.breachCollateralStep === 1 ? '(1 + B)' : `(1 + ${diplomacy.breachCollateralStep} x B)`} times the stated collateral to enter any new alliance.`,
    ...shared,
  ];
}

function buildSeatPrompt(matchId: string, seat: SeatConfig, spec: WargamesMatchSpecType): string {
  const lines = [
    `You are playing Wargames match "${spec.title}" (${matchId}) as seat ${seat.seatId} (${seat.label}).`,
    '',
    '=== WARGAMES RULEBOOK ===',
    objectiveLine(spec),
    '',
    ...unitLines(),
    '',
    'Loyalty & Capturing Villages:',
    ...loyaltyLines(),
    '',
    'Economy & Buildings (max level 10, 1 build per village per tick):',
    ...buildingLines(),
    ...landLines(spec),
    ...terrainLines(spec),
    '',
    'Diplomacy & Contracts:',
    ...diplomacyLines(),
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

  function nudgeIdleSeats(tick: number, phase: string, sessionIds: readonly string[], hasLand: boolean): void {
    const landHint = hasLand && phase === 'orders' ? ' When get_state yourLand.examples.claim is present, it is a claim order you can submit as written.' : '';
    for (const sessionId of sessionIds) {
      const session = sessions.get(sessionId);
      if (!session || session._destroyed || !IDLE_NUDGE_STATES.has(session.state)) continue;
      session.deliver(`Tick ${tick} (${phase} phase) started. Call get_state() to continue.${landHint}`, {
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
      onPhaseChanged: (_matchId, tick, phase, _status, sessionIds) => nudgeIdleSeats(tick, phase, sessionIds, true),
      onMatchEnded: (matchId, sessionIds) => { void cleanupMatchSessions(sessionIds, matchId); },
    });
  }

  return { start };
}
