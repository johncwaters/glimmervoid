import { AgentModelCatalog } from '#shared/contracts/agent-models.ts';
import {
  WARGAMES_MAP_SIZES,
  WARGAMES_RULES_VERSION,
  WARGAMES_SEAT_COUNTS,
  WARGAMES_SEAT_IDS,
  seatIdsForCount,
  victoryHoldTurnsFor,
  wargamesBalanceFor,
} from '#shared/contracts/wargames.ts';
import type {
  MessageChannel,
  OrderItem,
  SeatId,
  SeatStatus,
  TickPhase,
  WargamesMapSize,
  WargamesMatchSpec,
  WargamesMatchSummary,
  WargamesSeatCount,
} from '#shared/contracts/wargames.ts';
import { matchSeatIds, projectSeatState, seatReputationOf, seatStandingOf, victoryPointTargetOf, villageCountOf, villageTroopLoadOf } from '#shared/wargames/engine.ts';
import type { MatchState, SeatStanding } from '#shared/wargames/engine.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { settingsPayloadSnapshot, subscribeSettings } from '../settings/settings-store.ts';
import {
  CHAT_ICON_PATH,
  CHECK_ICON_PATH,
  createLineIcon,
  createSvgIcon,
  createSvgShape,
  KEY_ICON_PATH,
  TROPHY_ICON_PATH,
} from '../svg-dom.ts';
import { button } from '../ui/button.ts';
import { emptyState } from '../ui/empty-state.ts';
import { createPressable } from '../ui/pressable.ts';
import { select } from '../ui/select.ts';
import { textArea } from '../ui/text-input.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { GRAIN_COLOR, ORE_COLOR } from './wargames-econ-glyphs.ts';
import { createWargamesEconomy } from './wargames-economy.ts';
import { createEconomyLens } from './wargames-economy-lens.ts';
import { createDiplomacyLog } from './wargames-diplomacy-log.ts';
import { createTurnTrack } from './turn-track.ts';
import type { TurnTrack } from './turn-track.ts';
import type { TurnTrackInput } from './turn-track-core.ts';
import { createWargamesInspector } from './wargames-inspector.ts';
import { ACTING_PHASE_GLYPHS, WARGAMES_GLYPH_PATHS } from './wargames-glyphs.ts';
import {
  BEACON_GLYPH_PATH,
  BREACH_WARNING_PATH,
  BUILDING_GLYPH_PATHS,
  IMPROVEMENT_GLYPH_PATHS,
  CONTROL_FLAG_PATH,
  controlToneColor,
  createWargamesMap,
  isMatchOver,
  PACT_SCROLL_PATH,
  SCOUT_EYE_PATH,
  SEAT_COLORS,
  seatLabelOf,
  SUPPORT_DASH,
  TERRAIN_GLYPHS,
  THOUGHT_CLOUD_PATH,
  UNIT_GLYPH_PATHS,
  VILLAGE_GLYPH_PATH,
} from './wargames-map.ts';
import './wargames-panel.css';
import {
  displayedMatchAnalytics,
  displayedMatchState,
  displayedNotes,
  jumpReplayToEnd,
  replayView,
  seekReplayPhase,
  seekReplayTurn,
  selectWatchedMatch,
  setReplaySpeed,
  setWargamesPov,
  setWargamesResyncRequester,
  stepReplayTurn,
  subscribeWargames,
  toggleReplayPlay,
  wargamesSnapshot,
} from './wargames-store.ts';

type WargamesSubTab = 'live' | 'new' | 'history';
type WatchStreamState = 'idle' | 'loading' | 'failed';
type PanelBodyMode = 'unmounted' | 'empty' | 'loading' | 'failed' | 'live' | 'new' | 'history';
type PostgameReportMode = 'collapsed' | 'expanded';

interface PersistentLiveShell {
  readonly wrap: HTMLElement;
  readonly factionStripSlot: HTMLElement;
  readonly spotlightSlot: HTMLElement;
  readonly endgameSlot: HTMLElement;
  readonly boardBarSlot: HTMLElement;
  readonly hexIntelSlot: HTMLElement;
  readonly mapKeyPopover: HTMLElement;
}

interface PersistentPanelShell {
  readonly content: HTMLElement;
  readonly header: HTMLElement;
  readonly banner: HTMLElement;
  readonly body: HTMLElement;
}

const DEFAULT_SEAT_AGENTS: readonly string[] = [
  'claude-code',
  'codex',
  'kimi',
  'antigravity',
  'claude-code',
  'opencode',
];

const AGENT_OPTIONS = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'kimi', label: 'Kimi Code' },
  { value: 'antigravity', label: 'Antigravity' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'pi', label: 'pi' },
];

let root: HTMLElement | null = null;
let isViewActive = false;
let activeSubTab: WargamesSubTab = 'live';
let selectedHexIndex: number | null = null;
let spotlightSeatId: SeatId | null = null;
let watchStreamState: WatchStreamState = 'idle';
let bannerMessage = '';
let watchSelectionMode: 'auto' | 'manual' = 'auto';
let selectedHistoryVersion: string | null = null;
let postgameReportMode: PostgameReportMode = 'collapsed';
let unsubscribe: (() => void) | null = null;
const failedAutoWatchIds = new Set<string>();

let mapView: ReturnType<typeof createWargamesMap> | null = null;
let turnTrack: TurnTrack | null = null;
let inspectorView: ReturnType<typeof createWargamesInspector> | null = null;
let economyView: ReturnType<typeof createWargamesEconomy> | null = null;
let economyLens: ReturnType<typeof createEconomyLens> | null = null;
let diplomacyLog: ReturnType<typeof createDiplomacyLog> | null = null;
let persistentNewMatchSection: HTMLElement | null = null;
let panelShell: PersistentPanelShell | null = null;
let liveShell: PersistentLiveShell | null = null;
let mountedBodyMode: PanelBodyMode = 'unmounted';

function agentLabelOf(agentId: string): string {
  const matched = AGENT_OPTIONS.find((option) => option.value === agentId);
  return matched ? matched.label : agentId;
}

function resolveCatalogModelLabel(agentId: string, explicitModel: string | null): string | null {
  const parsed = AgentModelCatalog.safeParse(settingsPayloadSnapshot().agentModels);
  if (!parsed.success) return explicitModel;
  const entry = parsed.data.agents.find((candidate) => candidate.agent === agentId);
  if (!entry) return explicitModel;
  if (explicitModel) {
    const matched = entry.models.find(
      (model) => model.id === explicitModel || model.aliases.includes(explicitModel) || model.label === explicitModel,
    );
    return matched ? matched.label : explicitModel;
  }
  const configuredId = entry.configuredDefault?.model ?? null;
  if (configuredId) {
    const matched = entry.models.find((model) => model.id === configuredId || model.aliases.includes(configuredId));
    return matched ? matched.label : configuredId;
  }
  const defaultModel = entry.models.find((model) => model.isDefault);
  return defaultModel ? defaultModel.label : null;
}

function formatSeatAgentModel(agentId: string, model: string | null, modelDisplay: string): string {
  const agentName = agentLabelOf(agentId);
  const resolved = resolveCatalogModelLabel(agentId, model);
  if (resolved) return `${agentName} · ${resolved}`;
  const isGenericDisplay = modelDisplay === agentId || modelDisplay === `${agentId} (default)`;
  if (isGenericDisplay) return agentName;
  return `${agentName} · ${modelDisplay}`;
}

const ACTING_PHASE_LABELS: Readonly<Record<TickPhase, string>> = Object.freeze({
  talk: 'Talking',
  contracts: 'Negotiating',
  orders: 'Planning',
  resolving: 'Resolving',
  reported: 'Resolving',
});

const SEAT_STATUS_LABELS: Readonly<Record<SeatStatus, string>> = Object.freeze({
  disconnected: 'Connecting',
  connected: 'Ready',
  acting: 'Thinking',
  submitted: 'Locked in',
  timedOut: 'Timed out',
  eliminated: 'Eliminated',
});

const CONTRACT_KIND_LABELS: Readonly<Record<'escrow' | 'nap' | 'alliance', string>> = Object.freeze({
  escrow: 'Escrow deal',
  nap: 'Non-aggression pact',
  alliance: 'Alliance',
});

const MESSAGE_AUDIENCE_LABELS: Readonly<Record<MessageChannel, string>> = Object.freeze({
  dm: '',
  tribe: ' to tribe',
  public: ' to everyone',
});

const SEAT_STATUS_GLYPHS: Readonly<Record<SeatStatus, string>> = Object.freeze({
  disconnected: WARGAMES_GLYPH_PATHS.offline,
  connected: WARGAMES_GLYPH_PATHS.ready,
  acting: WARGAMES_GLYPH_PATHS.crosshair,
  submitted: CHECK_ICON_PATH,
  timedOut: WARGAMES_GLYPH_PATHS.clock,
  eliminated: WARGAMES_GLYPH_PATHS.skull,
});

const SEAT_STATUS_TONES: Readonly<Record<SeatStatus, string>> = Object.freeze({
  disconnected: 'var(--text-muted)',
  connected: 'var(--text-dim)',
  acting: 'var(--accent)',
  submitted: 'var(--state-running)',
  timedOut: 'var(--state-waiting)',
  eliminated: 'var(--state-failed)',
});

function createWargamesGlyph(pathData: string, size: number, color: string, ariaLabel?: string): SVGSVGElement {
  const icon = createLineIcon(pathData, '1.5');
  icon.setAttribute('width', String(size));
  icon.setAttribute('height', String(size));
  icon.style.color = color;
  if (ariaLabel) {
    icon.removeAttribute('aria-hidden');
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', ariaLabel);
  }
  return icon;
}

function buildResourceReadout(grain: number, ore: number): HTMLElement {
  const wrap = el('span', 'wg-faction-units');
  const grainChip = el('span', 'wg-legend-item');
  grainChip.append(createWargamesGlyph(WARGAMES_GLYPH_PATHS.grain, 12, GRAIN_COLOR, 'Grain'), el('span', '', String(grain)));
  const oreChip = el('span', 'wg-legend-item');
  oreChip.append(createWargamesGlyph(WARGAMES_GLYPH_PATHS.ore, 12, ORE_COLOR, 'Ore'), el('span', '', String(ore)));
  wrap.append(grainChip, oreChip);
  return wrap;
}

function buildGlyphChips<Key extends string>(
  glyphs: readonly { key: Key; label: string; path: string; color: string }[],
  counts: Readonly<Record<Key, number>>,
  options: { hideZero?: boolean; countPrefix?: string } = {},
): HTMLElement {
  const group = el('span', 'wg-faction-units');
  for (const glyph of glyphs) {
    if (options.hideZero === true && counts[glyph.key] <= 0) continue;
    const chip = el('span', 'wg-legend-item');
    chip.append(createWargamesGlyph(glyph.path, 13, glyph.color, glyph.label), el('span', '', `${options.countPrefix ?? ''}${counts[glyph.key]}`));
    group.append(chip);
  }
  return group;
}

function pluralized(count: number, singular: string): string {
  return count === 1 ? `${count} ${singular}` : `${count} ${singular}s`;
}

function displayedSeatStatus(state: MatchState, seat: MatchState['seats'][number]): SeatStatus {
  return state.readySeatIds.includes(seat.config.seatId) ? 'submitted' : seat.status;
}

function formatSeatStatusLabel(status: SeatStatus, phase: TickPhase, matchStatus: MatchState['status']): string {
  if (status === 'acting') return ACTING_PHASE_LABELS[phase];
  if (status === 'disconnected' && matchStatus !== 'seating' && matchStatus !== 'lobby') return 'Offline';
  return SEAT_STATUS_LABELS[status];
}

function seatStatusGlyphPath(status: SeatStatus, phase: TickPhase): string {
  if (status === 'acting') return ACTING_PHASE_GLYPHS[phase];
  return SEAT_STATUS_GLYPHS[status];
}

function ensureTurnTrack(): TurnTrack {
  turnTrack ??= createTurnTrack({
    seekTurn: seekReplayTurn,
    seekPhase: seekReplayPhase,
    stepTurn: stepReplayTurn,
    togglePlay: toggleReplayPlay,
    setSpeed: setReplaySpeed,
    jumpToEnd: jumpReplayToEnd,
  });
  return turnTrack;
}

function isReplayableStatus(status: MatchState['status']): boolean {
  return status === 'running' || status === 'finished' || status === 'aborted';
}

function trackLengthOf(state: MatchState, headState: MatchState): number {
  return headState.status === 'running' ? state.spec.maxTicks : Math.max(1, headState.tick);
}

function turnTrackInputOf(state: MatchState): TurnTrackInput {
  const headState = wargamesSnapshot().headState ?? state;
  return {
    status: state.status,
    tick: state.tick,
    maxTicks: trackLengthOf(state, headState),
    phase: state.phase,
    winnerSeatId: state.winnerSeatId,
    seats: state.seats.map((seat) => ({
      seatId: seat.config.seatId,
      label: seatLabelOf(state, seat.config.seatId),
      status: seat.status,
      isLockedIn: displayedSeatStatus(state, seat) === 'submitted',
    })),
    replay: isReplayableStatus(headState.status) ? replayView() : null,
  };
}

function formatError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function isActiveMatchStatus(status: WargamesMatchSummary['status']): boolean {
  return status === 'running' || status === 'seating' || status === 'lobby';
}

function pickAutoWatchMatchId(): string | null {
  const snap = wargamesSnapshot();
  const candidates = (snap.matches.length > 0 ? snap.matches : snap.history.matches)
    .filter((match) => !failedAutoWatchIds.has(match.matchId));
  if (candidates.length === 0) return null;
  const activeMatch = candidates.find((match) => isActiveMatchStatus(match.status));
  return activeMatch ? activeMatch.matchId : candidates[0].matchId;
}

function subscribeMatchStream(matchId: string): Promise<void> {
  watchStreamState = 'loading';
  bannerMessage = '';
  return sendControlRequest('wargames-watch', { matchId }, { timeoutMs: 15_000 })
    .then((reply) => {
      if (wargamesSnapshot().watchedMatchId !== matchId) return;
      if (reply.type !== 'wargames-watch-result') return;
      if (!reply.ok) {
        watchStreamState = 'failed';
        failedAutoWatchIds.add(matchId);
        bannerMessage = reply.error ?? 'Could not load match log.';
        render();
        return;
      }
      watchStreamState = 'idle';
      failedAutoWatchIds.delete(matchId);
      bannerMessage = '';
      render();
    })
    .catch((reason: unknown) => {
      if (wargamesSnapshot().watchedMatchId !== matchId) return;
      watchStreamState = 'failed';
      bannerMessage = `Could not watch match: ${formatError(reason)}`;
      render();
    });
}

function watchMatchById(matchId: string, switchToLive = true, selectionMode: 'auto' | 'manual' = 'auto', start: 'turn-one' | 'head' = 'head'): void {
  const current = wargamesSnapshot().watchedMatchId;
  if (current && current !== matchId) sendControlMsg({ type: 'wargames-unwatch', matchId: current });
  watchSelectionMode = selectionMode;
  failedAutoWatchIds.delete(matchId);
  bannerMessage = '';
  selectedHexIndex = null;
  spotlightSeatId = null;
  postgameReportMode = 'collapsed';
  setWargamesPov('god');
  selectWatchedMatch(matchId, start);
  if (switchToLive) activeSubTab = 'live';
  void subscribeMatchStream(matchId);
  render();
}

function ensureAutoWatch(): boolean {
  if (!isViewActive) return false;
  const snap = wargamesSnapshot();
  const allMatches = snap.matches.length > 0 ? snap.matches : snap.history.matches;
  const activeMatch = allMatches.find(
    (match) => isActiveMatchStatus(match.status) && !failedAutoWatchIds.has(match.matchId),
  );
  const watchedSummary = snap.watchedMatchId
    ? allMatches.find((match) => match.matchId === snap.watchedMatchId) ?? null
    : null;
  const isWatchingActive = watchedSummary !== null && isActiveMatchStatus(watchedSummary.status);
  if (activeMatch && !isWatchingActive && watchSelectionMode !== 'manual') {
    watchMatchById(activeMatch.matchId, false, 'auto');
    return true;
  }
  const canSwitchFromFailed = watchStreamState === 'failed' && snap.headState === null;
  if (snap.watchedMatchId !== null && !canSwitchFromFailed) return false;
  const candidateId = pickAutoWatchMatchId();
  if (!candidateId || candidateId === snap.watchedMatchId) return false;
  watchMatchById(candidateId, false, 'auto');
  return true;
}

function handleFactionBannerClick(seatId: SeatId): void {
  if (spotlightSeatId === seatId) {
    spotlightSeatId = null;
    setWargamesPov('god');
    render();
    return;
  }
  spotlightSeatId = seatId;
  setWargamesPov(seatId);
  render();
}

function ensureNewMatchSection(): HTMLElement {
  if (persistentNewMatchSection) return persistentNewMatchSection;
  const section = el('section', 'wg-form-section');
  section.append(
    el('h2', 'wg-section-title', 'New match'),
    el('p', 'wg-form-status', 'Fixed system rules are always injected first and cannot be edited. Optional strategy below is pre-game only.'),
  );
  const titleInput = el('input', 'wg-input') as HTMLInputElement;
  titleInput.value = 'Mixed-Model Research Match';
  const seedInput = el('input', 'wg-input') as HTMLInputElement;
  seedInput.type = 'number';
  seedInput.value = String(Math.floor(Math.random() * 900_000) + 100_000);
  const seatCountSelect = select({
    label: 'Seats',
    options: WARGAMES_SEAT_COUNTS.map((seatCount) => ({ value: String(seatCount), label: String(seatCount) })),
    value: String(WARGAMES_SEAT_IDS.length),
    onChange: () => showSeatRowsForCount(chosenSeatCount()),
  });
  const mapSizeSelect = select({
    label: 'Map',
    options: WARGAMES_MAP_SIZES.map((mapSize) => ({ value: mapSize.name, label: mapSize.name })),
    value: WARGAMES_MAP_SIZES[0].name,
  });
  const seatCountLabel = el('label', 'wg-card-meta', 'Seats ');
  seatCountLabel.append(seatCountSelect.element);
  const mapSizeLabel = el('label', 'wg-card-meta', 'Map ');
  mapSizeLabel.append(mapSizeSelect.element);
  const chosenSeatCount = (): WargamesSeatCount =>
    WARGAMES_SEAT_COUNTS.find((seatCount) => String(seatCount) === seatCountSelect.element.value) ?? WARGAMES_SEAT_COUNTS[1];
  const chosenMapSize = (): WargamesMapSize =>
    WARGAMES_MAP_SIZES.find((mapSize) => mapSize.name === mapSizeSelect.element.value) ?? WARGAMES_MAP_SIZES[0];

  const metaRow = el('div', 'wg-meta-inputs');
  metaRow.append(titleInput, seedInput, seatCountLabel, mapSizeLabel);
  section.append(metaRow);

  const seatInputs: {
    seatId: SeatId;
    row: HTMLElement;
    agentSelect: ReturnType<typeof select<string>>;
    modelInput: HTMLInputElement;
    instructionsInput: HTMLTextAreaElement;
  }[] = [];
  for (let index = 0; index < WARGAMES_SEAT_IDS.length; index += 1) {
    const seatId = WARGAMES_SEAT_IDS[index];
    const presetAgent = DEFAULT_SEAT_AGENTS[index];
    const row = el('div', 'wg-seat-row');
    const agentSelect = select({
      label: `Seat ${index + 1} agent`,
      options: AGENT_OPTIONS,
      value: presetAgent,
    });
    const modelInput = el('input', 'wg-input') as HTMLInputElement;
    modelInput.placeholder = 'default model';
    const instructionsInput = textArea({
      label: `Seat ${index + 1} pre-game strategy instructions`,
      placeholder: 'Optional pre-game strategy (appended after fixed rules)',
      rows: 2,
    });
    instructionsInput.maxLength = 4000;
    instructionsInput.classList.add('wg-seat-strategy');
    row.append(el('span', 'wg-seat-label', `Seat ${index + 1}`), agentSelect.element, modelInput, instructionsInput);
    section.append(row);
    seatInputs.push({ seatId, row, agentSelect, modelInput, instructionsInput });
  }
  const showSeatRowsForCount = (seatCount: WargamesSeatCount) => {
    const seatedIds = new Set(seatIdsForCount(seatCount));
    for (const entry of seatInputs) entry.row.hidden = !seatedIds.has(entry.seatId);
  };

  const formStatus = el('div', 'wg-form-status', '');
  const startButton = button({
    variant: 'primary',
    label: 'Start match',
    onClick: () => {
      startButton.disabled = true;
      formStatus.textContent = 'Starting match...';
      const mapSize = chosenMapSize();
      const seatedIds = new Set(seatIdsForCount(chosenSeatCount()));
      const spec: WargamesMatchSpec = {
        version: 1,
        rulesVersion: WARGAMES_RULES_VERSION,
        title: titleInput.value.trim() || 'Wargames Match',
        seed: Math.max(1, Number(seedInput.value) || 424242),
        mapRadius: mapSize.mapRadius,
        tickDeadlineSeconds: 60,
        maxTicks: mapSize.maxTicks,
        seats: seatInputs.filter((entry) => seatedIds.has(entry.seatId)).map((entry, index) => ({
          seatId: entry.seatId,
          label: `Seat ${index + 1}`,
          controllerKind: 'local-agent',
          setup: {
            agent: entry.agentSelect.element.value,
            model: entry.modelInput.value.trim() || null,
            options: [],
            instructions: entry.instructionsInput.value.trim(),
          },
          modelDisplay: formatSeatAgentModel(
            entry.agentSelect.element.value,
            entry.modelInput.value.trim() || null,
            entry.modelInput.value.trim() || entry.agentSelect.element.value,
          ),
        })),
      };
      void sendControlRequest('wargames-start', { spec }, { timeoutMs: 60_000 })
        .then((reply) => {
          startButton.disabled = false;
          if (reply.type !== 'wargames-start-result') return;
          if (!reply.ok || !reply.matchId) {
            formStatus.textContent = reply.error ?? 'Could not start match.';
            return;
          }
          formStatus.textContent = '';
          watchMatchById(reply.matchId);
        })
        .catch((error: unknown) => {
          startButton.disabled = false;
          formStatus.textContent = formatError(error);
        });
    },
  });
  section.append(startButton, formStatus);
  persistentNewMatchSection = section;
  return section;
}

interface SeatTally {
  readonly villages: number;
  readonly troops: { raider: number; guard: number; envoy: number };
  readonly totalUnits: number;
  readonly grain: number;
  readonly ore: number;
}

function tallySeats(state: MatchState): Map<SeatId, SeatTally> {
  const counts = new Map<SeatId, { villages: number; raider: number; guard: number; envoy: number; grain: number; ore: number }>();
  for (const seatId of matchSeatIds(state)) {
    counts.set(seatId, { villages: 0, raider: 0, guard: 0, envoy: 0, grain: 0, ore: 0 });
  }
  for (const village of state.villages) {
    if (!village || village.owner === null) continue;
    const entry = counts.get(village.owner);
    if (!entry) continue;
    if (!village.isBeacon) entry.villages += 1;
    entry.raider += village.troops.raider;
    entry.guard += village.troops.guard;
    entry.envoy += village.troops.envoy;
    entry.grain += village.resources.grain;
    entry.ore += village.resources.ore;
  }
  for (const army of state.armies.values()) {
    if (army.status !== 'marching' && army.status !== 'standing' && army.status !== 'returning') continue;
    const entry = counts.get(army.owner);
    if (!entry) continue;
    entry.raider += army.troops.raider;
    entry.guard += army.troops.guard;
    entry.envoy += army.troops.envoy;
  }
  const talliesBySeat = new Map<SeatId, SeatTally>();
  for (const [seatId, entry] of counts) {
    talliesBySeat.set(seatId, {
      villages: entry.villages,
      troops: { raider: entry.raider, guard: entry.guard, envoy: entry.envoy },
      totalUnits: entry.raider + entry.guard + entry.envoy,
      grain: entry.grain,
      ore: entry.ore,
    });
  }
  return talliesBySeat;
}

function buildFactionBannerStrip(state: MatchState): HTMLElement {
  const strip = el('div', 'wg-faction-strip');
  const tallies = tallySeats(state);
  for (const seat of state.seats) {
    const seatId = seat.config.seatId;
    const tally = tallies.get(seatId) ?? { villages: 0, troops: { raider: 0, guard: 0, envoy: 0 }, totalUnits: 0, grain: 0, ore: 0 };

    const isEliminated = seat.status === 'eliminated';
    const banner = createPressable('wg-faction-banner');
    banner.style.setProperty('--wg-seat-color', SEAT_COLORS[seatId]);
    const isSelected = spotlightSeatId === seatId;
    const isDimmed = spotlightSeatId !== null && !isSelected;
    banner.dataset.state = isSelected ? 'active' : isDimmed ? 'dimmed' : 'idle';
    if (isEliminated) banner.dataset.eliminated = 'true';
    banner.setAttribute('aria-pressed', String(isSelected));
    banner.addEventListener('click', () => handleFactionBannerClick(seatId));

    const statusLabel = formatSeatStatusLabel(displayedSeatStatus(state, seat), state.phase, state.status);
    const statusIcon = createWargamesGlyph(
      seatStatusGlyphPath(displayedSeatStatus(state, seat), state.phase),
      13,
      SEAT_STATUS_TONES[displayedSeatStatus(state, seat)],
      statusLabel,
    );

    const standing = seatStandingOf(state, seatId);
    const head = el('div', 'wg-faction-head');
    const nameWrap = el('span', 'wg-faction-name');
    const swatch = el('span', 'wg-faction-swatch');
    swatch.style.background = SEAT_COLORS[seatId];
    nameWrap.append(swatch, el('span', 'wg-faction-id', seat.config.label));
    const headRight = el('span', 'wg-faction-name');
    headRight.append(
      statusIcon,
      standingGlyph(standing, SEAT_COLORS[seatId]),
      el('span', 'wg-faction-villages', `${standing.score}/${standing.goal}`),
    );
    head.append(nameWrap, headRight);

    const agentAndModel = formatSeatAgentModel(seat.config.setup.agent, seat.config.setup.model, seat.config.modelDisplay);
    const modelLine = el('div', 'wg-faction-sub', agentAndModel);

    const track = el('div', 'wg-win-track');
    const fill = el('div', 'wg-win-fill');
    const winRatio = Math.min(100, Math.round((standing.score / standing.goal) * 100));
    fill.style.width = `${winRatio}%`;
    track.append(fill);

    const stats = el('div', 'wg-faction-stats');
    stats.append(buildGlyphChips(UNIT_GLYPH_PATHS, tally.troops), buildResourceReadout(tally.grain, tally.ore));

    banner.append(head, modelLine, track, stats);
    if (state.balance.diplomacy) banner.append(buildReputationReadout(seatReputationOf(state, seatId)));
    strip.append(banner);
  }
  return strip;
}

function buildReputationReadout(reputation: { kept: number; broken: number }): HTMLElement {
  const readout = el('div', 'wg-faction-sub wg-legend-item');
  readout.append(
    createWargamesGlyph(PACT_SCROLL_PATH, 12, 'var(--state-running)', 'Deals kept'),
    el('span', '', String(reputation.kept)),
    createWargamesGlyph(BREACH_WARNING_PATH, 12, 'var(--state-failed)', 'Deals broken'),
    el('span', '', String(reputation.broken)),
  );
  return readout;
}

function hexRouteElements(fromHexIndex: number, toHexIndex: number): HTMLElement[] {
  const arrow = el('span', 'wg-legend-item');
  arrow.append(createWargamesGlyph(WARGAMES_GLYPH_PATHS.arrow, 12, 'var(--text-dim)', 'to'));
  return [el('span', '', `#${fromHexIndex}`), arrow, el('span', '', `#${toHexIndex}`)];
}

function buildOrderElement(order: OrderItem, labelOf: (seatId: SeatId) => string): HTMLElement {
  const item = el('span', 'wg-legend-item');
  switch (order.kind) {
    case 'build': {
      const building = [...BUILDING_GLYPH_PATHS, ...IMPROVEMENT_GLYPH_PATHS].find((entry) => entry.key === order.building) ?? BUILDING_GLYPH_PATHS[0];
      item.append(
        createWargamesGlyph(building.path, 13, building.color, building.label),
        el('span', '', `Build ${building.label} at #${order.hexIndex}`),
      );
      return item;
    }
    case 'found':
      item.append(
        createWargamesGlyph(VILLAGE_GLYPH_PATH, 13, 'var(--text-dim)', 'Found village'),
        el('span', '', `Found village at #${order.hexIndex}`),
      );
      return item;
    case 'train': {
      const unit = UNIT_GLYPH_PATHS.find((entry) => entry.key === order.troop) ?? UNIT_GLYPH_PATHS[0];
      item.append(
        createWargamesGlyph(unit.path, 13, unit.color, unit.label),
        el('span', '', `Train ${pluralized(order.count, unit.label)} at #${order.hexIndex}`),
      );
      return item;
    }
    case 'march': {
      item.append(el('span', '', order.support === undefined ? 'March' : `Support ${labelOf(order.support)}`), ...hexRouteElements(order.fromHexIndex, order.toHexIndex));
      for (const unit of UNIT_GLYPH_PATHS) {
        if (order.troops[unit.key] <= 0) continue;
        item.append(createWargamesGlyph(unit.path, 13, unit.color, unit.label), el('span', '', String(order.troops[unit.key])));
      }
      return item;
    }
    case 'scout':
      item.append(
        createWargamesGlyph(SCOUT_EYE_PATH, 13, 'var(--text-dim)', 'Scout'),
        el('span', '', 'Scout'),
        ...hexRouteElements(order.fromHexIndex, order.toHexIndex),
      );
      return item;
    case 'tribe_join':
      item.append(el('span', '', `Join tribe with ${labelOf(order.partner)}`));
      return item;
    case 'tribe_leave':
      item.append(el('span', '', 'Leave tribe'));
      return item;
  }
}

function buildSpotlightBar(state: MatchState, seatId: SeatId): HTMLElement {
  const seat = state.seats.find((candidate) => candidate.config.seatId === seatId);
  const bar = el('section', 'wg-spotlight-bar');
  if (!seat) return bar;
  bar.style.setProperty('--wg-seat-color', SEAT_COLORS[seatId]);

  const head = el('div', 'wg-spotlight-head');
  const titleWrap = el('div', 'wg-card-title-row');
  const swatch = el('span', 'wg-faction-swatch');
  swatch.style.background = SEAT_COLORS[seatId];
  const agentAndModel = formatSeatAgentModel(seat.config.setup.agent, seat.config.setup.model, seat.config.modelDisplay);
  const tribePartner = seat.tribeId
    ? state.seats.find((candidate) => candidate.tribeId === seat.tribeId && candidate.config.seatId !== seatId)?.config.seatId ?? null
    : null;
  const labelOf = (otherSeatId: SeatId) => seatLabelOf(state, otherSeatId);
  const tribeTag = tribePartner ? ` · Tribe with ${labelOf(tribePartner)}` : '';
  titleWrap.append(
    swatch,
    el('span', 'wg-card-title', seat.config.label),
    el('span', 'wg-card-meta', `${agentAndModel} · ${formatSeatStatusLabel(displayedSeatStatus(state, seat), state.phase, state.status)}${tribeTag}`),
  );
  head.append(
    titleWrap,
    button({
      variant: 'quiet',
      size: 'small',
      label: 'Close',
      onClick: () => handleFactionBannerClick(seatId),
    }),
  );

  const noteCol = el('div', 'wg-dm-box');
  noteCol.append(
    el('div', 'wg-dm-label', 'Private scratchpad'),
    el('pre', 'wg-note-box', seat.note || 'No private note yet.'),
  );

  const currentTickMessages = state.messages.filter((message) => message.from === seatId && message.tick === state.tick);
  const recentMessages = currentTickMessages.length > 0
    ? currentTickMessages
    : state.messages.filter((message) => message.from === seatId).slice(-3);
  const saidCol = el('div', 'wg-dm-box');
  saidCol.append(el('div', 'wg-dm-label', 'Messages'));
  for (const message of recentMessages) {
    const audience = message.to ? ` to ${labelOf(message.to)}` : MESSAGE_AUDIENCE_LABELS[message.channel];
    saidCol.append(el('div', 'wg-dm-text', `Turn ${message.tick}${audience}: ${message.text}`));
  }
  if (recentMessages.length === 0) {
    saidCol.append(el('div', 'wg-dm-text', 'No messages yet.'));
  }

  const tickOrders = state.ordersByTick[state.tick] ?? state.ordersByTick[Math.max(1, state.tick - 1)];
  const orders = seat.sealedOrders.length > 0 ? seat.sealedOrders : (tickOrders?.[seatId] ?? []);
  const activeContracts = [...state.contracts.values()]
    .filter((contract) => contract.status === 'active' && (contract.proposer === seatId || contract.counterparty === seatId))
    .map((contract) => {
      const other = contract.proposer === seatId ? contract.counterparty : contract.proposer;
      const turnsLeft = contract.endTick === null ? '' : ` (${Math.max(0, contract.endTick - state.tick)} turns left)`;
      return `${CONTRACT_KIND_LABELS[contract.terms.kind]} with ${labelOf(other)}${turnsLeft}`;
    });
  const ordersList = el('div', 'wg-dm-text wg-hex-intel-group');
  for (const order of orders) {
    ordersList.append(buildOrderElement(order, labelOf));
  }
  if (activeContracts.length > 0) {
    const pactLine = el('span', 'wg-legend-item');
    pactLine.append(
      createWargamesGlyph(PACT_SCROLL_PATH, 13, 'var(--state-running)', 'Pacts'),
      el('span', 'wg-card-meta', `Pacts: ${activeContracts.join(', ')}`),
    );
    ordersList.append(pactLine);
  }
  if (orders.length === 0 && activeContracts.length === 0) {
    ordersList.append(el('span', '', 'Holding position'));
  }
  const ordersCol = el('div', 'wg-dm-box');
  ordersCol.append(el('div', 'wg-dm-label', 'Orders & contracts'), ordersList);

  const grid = el('div', 'wg-spotlight-grid');
  grid.append(noteCol, saidCol, ordersCol);
  bar.append(head, grid);
  return bar;
}

function buildEndgameCard(state: MatchState): HTMLElement {
  const card = el('section', 'wg-endgame-card');
  const tallies = tallySeats(state);
  const winnerSeat = state.winnerSeatId
    ? state.seats.find((seat) => seat.config.seatId === state.winnerSeatId) ?? null
    : null;
  const winnerColor = state.winnerSeatId ? SEAT_COLORS[state.winnerSeatId] : 'var(--border-hover)';
  card.style.borderColor = winnerColor;

  const breachesBySeat = new Map<SeatId, number>();
  const messagesBySeat = new Map<SeatId, number>();
  for (const seatId of matchSeatIds(state)) {
    breachesBySeat.set(seatId, 0);
    messagesBySeat.set(seatId, 0);
  }
  for (const entry of state.ledger) {
    breachesBySeat.set(entry.breacher, (breachesBySeat.get(entry.breacher) ?? 0) + 1);
  }
  for (const message of state.messages) {
    messagesBySeat.set(message.from, (messagesBySeat.get(message.from) ?? 0) + 1);
  }

  const ranked = [...state.seats].sort((left, right) => {
    if (left.config.seatId === state.winnerSeatId) return -1;
    if (right.config.seatId === state.winnerSeatId) return 1;
    const leftScore = seatStandingOf(state, left.config.seatId).score;
    const rightScore = seatStandingOf(state, right.config.seatId).score;
    if (rightScore !== leftScore) return rightScore - leftScore;
    const leftCount = tallies.get(left.config.seatId)?.villages ?? 0;
    const rightCount = tallies.get(right.config.seatId)?.villages ?? 0;
    if (rightCount !== leftCount) return rightCount - leftCount;
    const leftUnits = tallies.get(left.config.seatId)?.totalUnits ?? 0;
    const rightUnits = tallies.get(right.config.seatId)?.totalUnits ?? 0;
    return rightUnits - leftUnits;
  });

  const head = el('div', 'wg-endgame-head');
  const winnerWrap = el('div', 'wg-endgame-winner');
  const emblem = createWargamesGlyph(
    state.status === 'aborted' ? WARGAMES_GLYPH_PATHS.breach : TROPHY_ICON_PATH,
    20,
    winnerColor,
    state.status === 'aborted' ? 'Aborted' : 'Champion',
  );
  const titleGroup = el('div', 'wg-endgame-titles');
  const headingText = winnerSeat
    ? `VICTORY · ${winnerSeat.config.label.toUpperCase()}`
    : state.status === 'aborted'
      ? 'MATCH ABORTED'
      : 'MATCH FINISHED';
  const heading = el('div', 'wg-endgame-title', headingText);
  const sub = el('div', 'wg-card-meta', `Rules ${state.spec.rulesVersion} · Turn ${state.tick}/${state.spec.maxTicks}`);
  titleGroup.append(heading, sub);
  winnerWrap.append(emblem, titleGroup);

  const actions = el('div', 'wg-endgame-actions');
  const reportBtn = button({
    variant: 'secondary',
    size: 'small',
    label: 'Match report',
    onClick: () => {
      postgameReportMode = postgameReportMode === 'expanded' ? 'collapsed' : 'expanded';
      render();
    },
  });
  reportBtn.setAttribute('aria-expanded', String(postgameReportMode === 'expanded'));
  actions.append(
    reportBtn,
    button({
      variant: 'primary',
      size: 'small',
      label: 'New match',
      onClick: () => {
        activeSubTab = 'new';
        render();
      },
    }),
  );
  head.append(winnerWrap, actions);

  const podium = el('div', 'wg-podium-grid');
  for (let rankIndex = 0; rankIndex < 3; rankIndex += 1) {
    const seat = ranked[rankIndex];
    if (!seat) continue;
    const seatId = seat.config.seatId;
    const slot = el('div', 'wg-podium-slot');
    slot.style.setProperty('--wg-seat-color', SEAT_COLORS[seatId]);
    slot.dataset.rank = String(rankIndex + 1);

    const standing = seatStandingOf(state, seatId);
    const topRow = el('div', 'wg-faction-head');
    const rankLabel = el('span', 'wg-faction-name');
    if (rankIndex === 0) {
      rankLabel.append(createWargamesGlyph(TROPHY_ICON_PATH, 14, SEAT_COLORS[seatId], 'First place'));
    }
    rankLabel.append(el('span', 'wg-podium-rank', rankIndex === 0 ? '#1 Champion' : `#${rankIndex + 1}`));
    topRow.append(rankLabel, el('span', 'wg-podium-score', `${standing.score}/${standing.goal}`));

    const nameRow = el('div', 'wg-faction-name');
    const swatch = el('span', 'wg-faction-swatch');
    swatch.style.background = SEAT_COLORS[seatId];
    nameRow.append(swatch, el('span', 'wg-faction-id', seat.config.label));

    const modelText = el(
      'div',
      'wg-faction-sub',
      formatSeatAgentModel(seat.config.setup.agent, seat.config.setup.model, seat.config.modelDisplay),
    );
    const track = el('div', 'wg-win-track');
    const fill = el('div', 'wg-win-fill');
    fill.style.width = `${Math.min(100, Math.round((standing.score / standing.goal) * 100))}%`;
    track.append(fill);

    slot.append(topRow, nameRow, modelText, track);
    podium.append(slot);
  }

  const awards = el('div', 'wg-awards-strip');
  const addAward = (glyphPath: string, glyphColor: string, title: string, seatLabel: string, stat: string, seatColor: string) => {
    const chip = el('span', 'wg-award-chip');
    chip.style.setProperty('--wg-seat-color', seatColor);
    chip.append(
      createWargamesGlyph(glyphPath, 12, glyphColor, title),
      el('span', 'wg-award-title', title),
      el('span', 'wg-faction-id', seatLabel),
      el('span', 'wg-card-meta', stat),
    );
    awards.append(chip);
  };

  const warlord = [...state.seats].sort((left, right) => (
    (tallies.get(right.config.seatId)?.totalUnits ?? 0) - (tallies.get(left.config.seatId)?.totalUnits ?? 0)
  ))[0];
  if (warlord) {
    const warlordUnits = tallies.get(warlord.config.seatId)?.totalUnits ?? 0;
    if (warlordUnits > 0) {
      addAward(WARGAMES_GLYPH_PATHS.swords, SEAT_COLORS[warlord.config.seatId], 'Warlord', warlord.config.label, pluralized(warlordUnits, 'unit'), SEAT_COLORS[warlord.config.seatId]);
    }
  }

  const backstabber = [...state.seats].sort((left, right) => (
    (breachesBySeat.get(right.config.seatId) ?? 0) - (breachesBySeat.get(left.config.seatId) ?? 0)
  ))[0];
  if (backstabber && (breachesBySeat.get(backstabber.config.seatId) ?? 0) > 0) {
    const count = breachesBySeat.get(backstabber.config.seatId) ?? 0;
    addAward(WARGAMES_GLYPH_PATHS.breach, 'var(--state-waiting)', 'Backstabber', backstabber.config.label, count === 1 ? '1 breach' : `${count} breaches`, SEAT_COLORS[backstabber.config.seatId]);
  }

  const diplomat = [...state.seats].sort((left, right) => (
    (messagesBySeat.get(right.config.seatId) ?? 0) - (messagesBySeat.get(left.config.seatId) ?? 0)
  ))[0];
  if (diplomat && (messagesBySeat.get(diplomat.config.seatId) ?? 0) > 0) {
    const msgCount = messagesBySeat.get(diplomat.config.seatId) ?? 0;
    addAward(CHAT_ICON_PATH, SEAT_COLORS[diplomat.config.seatId], 'Diplomat', diplomat.config.label, pluralized(msgCount, 'message'), SEAT_COLORS[diplomat.config.seatId]);
  }

  const table = el('table', 'wg-table');
  const thead = el('thead');
  const headRow = el('tr');
  headRow.append(
    el('th', '', '#'),
    el('th', '', 'Faction'),
    el('th', '', 'Model'),
    el('th', '', 'Territory'),
    el('th', '', 'Army'),
    el('th', 'wg-num', 'Breaches'),
    el('th', 'wg-num', 'State'),
  );
  thead.append(headRow);
  const tbody = el('tbody');

  for (let index = 0; index < ranked.length; index += 1) {
    const seat = ranked[index];
    const seatId = seat.config.seatId;
    const tally = tallies.get(seatId) ?? { villages: 0, troops: { raider: 0, guard: 0, envoy: 0 }, totalUnits: 0, grain: 0, ore: 0 };
    const breaches = breachesBySeat.get(seatId) ?? 0;
    const tr = el('tr', 'wg-leaderboard-row');
    if (seat.status === 'eliminated') tr.dataset.eliminated = 'true';

    const factionCell = el('td');
    const factionWrap = el('span', 'wg-faction-name');
    const swatch = el('span', 'wg-faction-swatch');
    swatch.style.background = SEAT_COLORS[seatId];
    factionWrap.append(swatch, el('span', 'wg-faction-id', seat.config.label));
    factionCell.append(factionWrap);

    const modelCell = el('td', 'wg-card-meta', formatSeatAgentModel(seat.config.setup.agent, seat.config.setup.model, seat.config.modelDisplay));

    const standing = seatStandingOf(state, seatId);
    const territoryCell = el('td');
    const territoryWrap = el('div', 'wg-leaderboard-bar');
    const track = el('div', 'wg-win-track');
    track.style.setProperty('--wg-seat-color', SEAT_COLORS[seatId]);
    const fill = el('div', 'wg-win-fill');
    fill.style.width = `${Math.min(100, Math.round((standing.score / standing.goal) * 100))}%`;
    track.append(fill);
    territoryWrap.append(track, el('span', 'wg-faction-villages', `${standing.score}/${standing.goal}`));
    territoryCell.append(territoryWrap);

    const armyCell = el('td');
    armyCell.append(buildGlyphChips(UNIT_GLYPH_PATHS, tally.troops));

    const breachCell = el('td', 'wg-num');
    if (breaches > 0) {
      const breachChip = el('span', 'wg-legend-item');
      breachChip.append(createWargamesGlyph(WARGAMES_GLYPH_PATHS.breach, 12, 'var(--state-waiting)', 'Breaches'), el('span', '', String(breaches)));
      breachCell.append(breachChip);
    }
    if (breaches === 0) {
      breachCell.textContent = '-';
    }

    const stateCell = el('td', 'wg-num');
    const isChampion = seatId === state.winnerSeatId;
    const stateIcon = isChampion
      ? createWargamesGlyph(TROPHY_ICON_PATH, 13, SEAT_COLORS[seatId], 'Winner')
      : seat.status === 'eliminated'
        ? createWargamesGlyph(WARGAMES_GLYPH_PATHS.skull, 13, 'var(--state-failed)', 'Eliminated')
        : createWargamesGlyph(CHECK_ICON_PATH, 13, 'var(--state-running)', 'Survived');
    stateCell.append(stateIcon);

    tr.append(el('td', 'wg-card-meta', `#${index + 1}`), factionCell, modelCell, territoryCell, armyCell, breachCell, stateCell);
    tbody.append(tr);
  }
  table.append(thead, tbody);

  card.append(head, podium);
  if (awards.childElementCount > 0) card.append(awards);
  card.append(table);
  return card;
}

function buildHexIntelBar(state: MatchState, pov: ReturnType<typeof wargamesSnapshot>['pov']): HTMLElement {
  const bar = el('div', 'wg-hex-intel');
  if (selectedHexIndex === null) {
    bar.append(el('span', 'wg-card-meta', 'Click a hex to inspect it'));
    return bar;
  }

  const tile = state.hexes[selectedHexIndex];
  if (!tile) {
    bar.append(el('span', 'wg-card-meta', 'Click a hex to inspect it'));
    return bar;
  }
  const seatView = pov === 'god' ? null : projectSeatState(state, pov);
  const village = seatView
    ? seatView.visibleVillages.find((entry) => entry.hexIndex === selectedHexIndex) ?? null
    : state.villages[selectedHexIndex];
  const isFogged = seatView !== null && state.villages[selectedHexIndex] !== null && village === null;

  if (isFogged) {
    bar.append(el('span', 'wg-hex-intel-lead', `#${tile.index}`), el('span', 'wg-card-meta', 'Hidden by fog of war'));
    return bar;
  }

  const land = village ? undefined : state.territory.get(tile.index);
  if (land) return buildLandIntel(bar, state, tile.index, land, armiesOnTile(state, pov, tile.index));
  if (!village) {
    bar.append(el('span', 'wg-hex-intel-lead', `#${tile.index}`), el('span', 'wg-card-meta', state.balance.territory === null ? 'Open land, no village' : 'Open land, unclaimed'));
    const armies = armiesOnTile(state, pov, tile.index);
    if (armies.length > 0) bar.append(buildTileArmyGroup(state, armies));
    return bar;
  }

  const left = el('div', 'wg-hex-intel-group');
  left.append(el('span', 'wg-hex-intel-lead', `#${tile.index}`));
  if (village.owner !== null) {
    const swatch = el('span', 'wg-faction-swatch');
    swatch.style.background = SEAT_COLORS[village.owner];
    const ownerTag = el('span', 'wg-hex-intel-owner', seatLabelOf(state, village.owner));
    ownerTag.style.color = SEAT_COLORS[village.owner];
    left.append(swatch, ownerTag);
  }
  if (village.owner === null) {
    left.append(el('span', 'wg-hex-intel-owner', 'Barbarians'));
  }
  const controlTone = controlToneColor(village.loyalty, village.owner);
  const controlChip = el('span', 'wg-legend-item');
  controlChip.append(createWargamesGlyph(CONTROL_FLAG_PATH, 12, controlTone, 'Control'), el('span', '', `Control ${village.loyalty}%`));
  left.append(controlChip);
  if (village.productionState === 'barren') {
    left.append(el('span', 'wg-card-meta', 'Barren'));
  }

  const right = el('div', 'wg-hex-intel-group');
  right.append(
    buildGlyphChips(UNIT_GLYPH_PATHS, village.troops, { hideZero: true }),
    ...village.guests.map((guest) => buildGuestChips(state, guest)),
    ...buildingAndLoadChips(state, village),
    buildResourceReadout(village.resources.grain, village.resources.ore),
  );

  bar.append(left, right);
  return bar;
}

type LandTile = NonNullable<ReturnType<MatchState['territory']['get']>>;

function improvementEffectOf(state: MatchState, hexIndex: number, land: LandTile): string {
  const rule = state.balance.territory;
  if (rule === null || land.improvement === null) return '';
  if (land.improvement === 'field') return `+${land.level * rule.improvements.field.yieldPerLevel} grain to the village beside it`;
  if (land.improvement === 'quarry') {
    const oreTileBonus = state.terrain[hexIndex] === 'ore' ? rule.quarryOreTileBonus : 0;
    return `+${land.level * (rule.improvements.quarry.yieldPerLevel + oreTileBonus)} ore to the nearest village`;
  }
  if (land.improvement === 'watchtower') return `Sees armies within ${rule.watchtowerRange} hexes`;
  return `Armies holding it defend at +${Math.round(rule.outpostDefenseBonus * 100)}%`;
}

type TileArmy = Pick<NonNullable<ReturnType<MatchState['armies']['get']>>, 'owner' | 'status' | 'troops' | 'currentHexIndex' | 'targetHexIndex' | 'originHexIndex'>;

function armiesOnTile(state: MatchState, pov: ReturnType<typeof wargamesSnapshot>['pov'], hexIndex: number): TileArmy[] {
  const armies: TileArmy[] = pov === 'god' ? [...state.armies.values()] : projectSeatState(state, pov).visibleArmies;
  return armies.filter((army) => army.currentHexIndex === hexIndex && (army.status === 'standing' || army.status === 'marching' || army.status === 'returning'));
}

function armyOrderText(army: TileArmy): string {
  if (army.status === 'standing') return 'holding';
  if (army.status === 'returning') return `home to #${army.originHexIndex}`;
  return `to #${army.targetHexIndex}`;
}

function buildTileArmyGroup(state: MatchState, armies: readonly TileArmy[]): HTMLElement {
  const group = el('div', 'wg-hex-intel-group');
  for (const army of armies) {
    const owner = el('span', 'wg-hex-intel-owner', seatLabelOf(state, army.owner));
    owner.style.color = SEAT_COLORS[army.owner];
    group.append(owner, buildGlyphChips(UNIT_GLYPH_PATHS, army.troops, { hideZero: true }), el('span', 'wg-card-meta', armyOrderText(army)));
  }
  return group;
}

function buildLandIntel(bar: HTMLElement, state: MatchState, hexIndex: number, land: LandTile, armies: readonly TileArmy[]): HTMLElement {
  const left = el('div', 'wg-hex-intel-group');
  const swatch = el('span', 'wg-faction-swatch');
  swatch.style.background = SEAT_COLORS[land.owner];
  const ownerTag = el('span', 'wg-hex-intel-owner', seatLabelOf(state, land.owner));
  ownerTag.style.color = SEAT_COLORS[land.owner];
  const tilesPerPoint = state.balance.territory?.tilesPerPoint ?? 0;
  left.append(el('span', 'wg-hex-intel-lead', `#${hexIndex}`), swatch, ownerTag, el('span', 'wg-card-meta', `Land, 1 VP per ${tilesPerPoint} tiles`));
  const right = el('div', 'wg-hex-intel-group');
  const improvement = IMPROVEMENT_GLYPH_PATHS.find((entry) => entry.key === land.improvement);
  if (improvement) {
    const chip = el('span', 'wg-legend-item');
    chip.append(createWargamesGlyph(improvement.path, 13, improvement.color, improvement.label), el('span', '', `${improvement.label} Lv ${land.level}`));
    right.append(chip, el('span', 'wg-card-meta', improvementEffectOf(state, hexIndex, land)));
  }
  bar.append(left, right);
  if (armies.length > 0) bar.append(buildTileArmyGroup(state, armies));
  return bar;
}

function buildGuestChips(state: MatchState, guest: NonNullable<MatchState['villages'][number]>['guests'][number]): HTMLElement {
  const group = el('span', 'wg-hex-intel-guests');
  group.style.setProperty('--wg-seat-color', SEAT_COLORS[guest.owner]);
  group.append(el('span', 'wg-hex-intel-guest-owner', seatLabelOf(state, guest.owner)));
  for (const unit of UNIT_GLYPH_PATHS) {
    if (guest.troops[unit.key] <= 0) continue;
    const chip = el('span', 'wg-legend-item');
    chip.append(createWargamesGlyph(unit.path, 13, SEAT_COLORS[guest.owner], `${unit.label} lent by ${seatLabelOf(state, guest.owner)}`), el('span', '', String(guest.troops[unit.key])));
    group.append(chip);
  }
  return group;
}

function buildingAndLoadChips(state: MatchState, village: NonNullable<MatchState['villages'][number]>): HTMLElement[] {
  const load = villageTroopLoadOf(state, village);
  if (load === null) return [buildGlyphChips(BUILDING_GLYPH_PATHS, village.buildings, { hideZero: true, countPrefix: 'Lv ' })];
  const wallChip = el('span', 'wg-legend-item');
  wallChip.append(createWargamesGlyph(WALL_GLYPH.path, 13, WALL_GLYPH.color, WALL_GLYPH.label), el('span', '', `${village.buildings.wall}/${WALL_MAX_LEVEL}`));
  return [
    buildGlyphChips(BUILDING_GLYPH_PATHS.filter((building) => building.key !== 'wall'), village.buildings, { hideZero: true, countPrefix: 'Lv ' }),
    wallChip,
    el('span', 'wg-card-meta', `Troops ${load.counted}/${load.cap}`),
  ];
}

function legendItem(icon: SVGSVGElement, label: string): HTMLElement {
  const item = el('span', 'wg-legend-item');
  item.append(icon, el('span', '', label));
  return item;
}

function legendGroup(title: string, items: readonly HTMLElement[]): HTMLElement {
  const group = el('div', 'wg-legend-group');
  group.append(el('span', 'wg-legend-heading', title), ...items);
  return group;
}

function hexSwatchIcon(fill: string, stroke: string, dasharray: string | null): SVGSVGElement {
  const icon = createSvgIcon(12, 12);
  const attributes: Record<string, string> = {
    points: '6,1 11,3.5 11,8.5 6,11 1,8.5 1,3.5',
    fill,
    stroke,
    'stroke-width': '1.2',
  };
  if (dasharray) attributes['stroke-dasharray'] = dasharray;
  icon.append(createSvgShape('polygon', attributes));
  return icon;
}

function arrowSwatchIcon(dasharray: string): SVGSVGElement {
  const icon = createSvgIcon(16, 12);
  icon.append(
    createSvgShape('line', {
      x1: '1',
      y1: '6',
      x2: '11',
      y2: '6',
      stroke: 'var(--text-head)',
      'stroke-width': '2',
      'stroke-dasharray': dasharray,
    }),
    createSvgShape('polygon', { points: '10,3 15,6 10,9', fill: 'var(--text-head)' }),
  );
  return icon;
}

const WALL_MAX_LEVEL = 10;
const WALL_GLYPH = BUILDING_GLYPH_PATHS.find((building) => building.key === 'wall') ?? BUILDING_GLYPH_PATHS[0];

interface LegendRow {
  readonly glyphPath: string;
  readonly color: string;
  readonly label: string;
}

function unitLegendRows(rulesVersion: WargamesMatchSpec['rulesVersion']): { title: string; rows: LegendRow[] } {
  const roles = wargamesBalanceFor(rulesVersion).roles;
  const unitRows = UNIT_GLYPH_PATHS.map((unit) => ({
    glyphPath: unit.path,
    color: unit.color,
    label: roles === null ? unit.label : `${unit.label} ${roles.units[unit.key].attack}/${roles.units[unit.key].defense}`,
  }));
  if (roles === null) return { title: 'Units', rows: unitRows };
  return {
    title: 'Units attack/defense',
    rows: [
      ...unitRows,
      { glyphPath: UNIT_GLYPH_PATHS[1].path, color: SEAT_COLORS.s2, label: 'Ally guests' },
      { glyphPath: WALL_GLYPH.path, color: WALL_GLYPH.color, label: `Wall up to ${WALL_MAX_LEVEL}` },
    ],
  };
}

function unitLegendGroup(rulesVersion: WargamesMatchSpec['rulesVersion']): HTMLElement {
  const { title, rows } = unitLegendRows(rulesVersion);
  return legendGroup(title, rows.map((row) => legendItem(createWargamesGlyph(row.glyphPath, 14, row.color), row.label)));
}

function landLegendGroups(rulesVersion: WargamesMatchSpec['rulesVersion']): HTMLElement[] {
  if (wargamesBalanceFor(rulesVersion).territory === null) return [];
  return [legendGroup('Land', [
    legendItem(hexSwatchIcon(`color-mix(in srgb, ${SEAT_COLORS.s1} 11%, var(--bg-surface))`, `color-mix(in srgb, ${SEAT_COLORS.s1} 45%, var(--border))`, null), 'Land'),
    ...IMPROVEMENT_GLYPH_PATHS.map((improvement) => legendItem(createWargamesGlyph(improvement.path, 14, improvement.color), improvement.label)),
  ])];
}

function buildMapLegend(rulesVersion: WargamesMatchSpec['rulesVersion']): HTMLElement {
  const legend = el('div', 'wg-map-legend');
  legend.append(
    unitLegendGroup(rulesVersion),
    legendGroup('Buildings', BUILDING_GLYPH_PATHS.map((building) => legendItem(createWargamesGlyph(building.path, 14, building.color), building.label))),
    ...landLegendGroups(rulesVersion),
    legendGroup('Board', [
      legendItem(hexSwatchIcon(`color-mix(in srgb, ${SEAT_COLORS.s1} 28%, var(--bg-card))`, SEAT_COLORS.s1, null), 'Faction village'),
      legendItem(hexSwatchIcon('color-mix(in srgb, var(--text-dim) 10%, var(--bg-card))', 'var(--border-hover)', null), 'Barbarian village'),
      legendItem(hexSwatchIcon('var(--bg)', 'var(--border-hover)', '2 2'), 'Barren'),
      legendItem(createWargamesGlyph(CONTROL_FLAG_PATH, 14, 'var(--state-waiting)'), 'Control under 100%, lower falls sooner'),
      legendItem(createWargamesGlyph(BEACON_GLYPH_PATH, 14, 'var(--text-head)'), 'Beacon'),
      ...Object.values(TERRAIN_GLYPHS).map((terrain) => legendItem(createWargamesGlyph(terrain.path, 14, terrain.color), terrain.label)),
    ]),
    legendGroup('Moves', [
      legendItem(arrowSwatchIcon('4 2'), 'Army marching'),
      legendItem(arrowSwatchIcon('2 3'), 'Planned order (seat view or selected hex)'),
      legendItem(arrowSwatchIcon(SUPPORT_DASH), 'Support'),
      legendItem(createWargamesGlyph(SCOUT_EYE_PATH, 14, 'var(--text-head)'), 'Scout'),
    ]),
    legendGroup('Diplomacy', [
      legendItem(createWargamesGlyph(CHAT_ICON_PATH, 14, 'var(--text-head)'), 'Message'),
      legendItem(createWargamesGlyph(THOUGHT_CLOUD_PATH, 14, 'var(--text-head)'), 'Private thought'),
      legendItem(createWargamesGlyph(PACT_SCROLL_PATH, 14, 'var(--state-running)'), 'Pact'),
      legendItem(createWargamesGlyph(BREACH_WARNING_PATH, 14, 'var(--state-failed)'), 'Breach'),
    ]),
  );
  return legend;
}

function buildMapKey(): { keySlot: HTMLElement; legend: HTMLElement } {
  const legend = el('div', 'wg-map-legend');
  legend.popover = 'auto';
  legend.id = 'wg-map-key';
  const keyButton = button({ variant: 'icon', size: 'small', label: 'Key', icon: createLineIcon(KEY_ICON_PATH, '1.5') });
  keyButton.popoverTargetElement = legend;
  legend.addEventListener('beforetoggle', (event) => {
    if (!(event instanceof ToggleEvent) || event.newState !== 'open') return;
    const buttonBox = keyButton.getBoundingClientRect();
    legend.style.left = `${buttonBox.left}px`;
    legend.style.bottom = `${window.innerHeight - buttonBox.top + 6}px`;
  });
  const keySlot = el('div', 'wg-map-key');
  keySlot.append(keyButton, legend);
  return { keySlot, legend };
}

function buildHistorySection(): HTMLElement {
  const { history, matches } = wargamesSnapshot();
  const wrapper = el('section', 'wg-history-grid');
  const currentVersion = history.currentRulesVersion || WARGAMES_RULES_VERSION;
  const availableVersions = [...new Set([
    currentVersion,
    ...Object.keys(history.eloByVersion),
    ...history.matches.map((match) => match.rulesVersion),
  ])].sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  const activeVersion = selectedHistoryVersion && availableVersions.includes(selectedHistoryVersion)
    ? selectedHistoryVersion
    : currentVersion;
  const eloRows = history.eloByVersion[activeVersion]
    ?? (activeVersion === currentVersion ? history.eloByModel : []);

  const eloBox = el('div', 'wg-form-section');
  const eloHead = el('div', 'wg-history-head');
  eloHead.append(el('h2', 'wg-section-title', `Model Elo Leaderboard (${activeVersion})`));
  if (availableVersions.length > 1) {
    const versionPicker = select({
      label: 'Ruleset version',
      size: 'small',
      value: activeVersion,
      options: availableVersions.map((ver) => ({
        value: ver,
        label: ver === currentVersion ? `${ver} (current)` : ver,
      })),
      onChange: (nextVersion) => {
        selectedHistoryVersion = nextVersion;
        render();
      },
    });
    eloHead.append(versionPicker.element);
  }
  eloBox.append(eloHead);
  if (eloRows.length === 0) {
    eloBox.append(el('p', 'wg-empty-copy', `Finish a ${activeVersion} match to populate model Elo ratings.`));
  }
  if (eloRows.length > 0) {
    const table = el('table', 'wg-table');
    const headRow = el('tr');
    headRow.append(el('th', '', 'Model'), el('th', 'wg-num', 'Elo'), el('th', 'wg-num', 'Wins'), el('th', 'wg-num', 'Matches'), el('th', 'wg-num', 'Breaches'));
    table.append(el('thead', '', ''), el('tbody'));
    table.tHead?.append(headRow);
    const tbody = table.tBodies[0];
    for (const row of eloRows) {
      const tr = el('tr');
      tr.append(
        el('td', '', row.modelDisplay),
        el('td', 'wg-num', String(row.elo)),
        el('td', 'wg-num', String(row.wins)),
        el('td', 'wg-num', String(row.matchesPlayed)),
        el('td', 'wg-num', String(row.breaches)),
      );
      tbody.append(tr);
    }
    eloBox.append(table);
  }

  const listBox = el('div', 'wg-form-section');
  listBox.append(el('h2', 'wg-section-title', 'Match History'));
  const allMatches = matches.length > 0 ? matches : history.matches;
  if (allMatches.length === 0) {
    listBox.append(el('p', 'wg-empty-copy', 'No matches recorded yet.'));
  }
  for (const match of allMatches) {
    const row = el('div', 'wg-history-row');
    const matchMeta = el('div', 'wg-history-info');
    const strategyTag = match.hasCustomStrategy ? ' · Custom strategy' : '';
    matchMeta.append(
      el('div', 'wg-card-title', `${match.title} (${match.matchId})`),
      el('div', 'wg-card-meta', `Rules ${match.rulesVersion} · ${match.status} · Turn ${match.tick}/${match.maxTicks} · Winner: ${match.winnerModelDisplay ?? '-'} · Breaches: ${match.breachCount}${strategyTag}`),
    );
    const watchBtn = button({
      variant: 'secondary',
      size: 'small',
      label: 'Watch',
      onClick: () => {
        const isActiveMatch = isActiveMatchStatus(match.status);
        watchMatchById(match.matchId, true, isActiveMatch ? 'auto' : 'manual', isActiveMatch ? 'head' : 'turn-one');
      },
    });
    row.append(matchMeta, watchBtn);
    listBox.append(row);
  }

  wrapper.append(eloBox, listBox);
  return wrapper;
}

function ensurePanelShell(): PersistentPanelShell {
  if (panelShell) return panelShell;
  const content = el('div', 'wg-content');
  const header = el('header', 'wg-header');
  const banner = el('div', 'wg-form-status');
  banner.hidden = true;
  const body = el('div', 'wg-body');
  content.append(header, banner, body);
  panelShell = { content, header, banner, body };
  return panelShell;
}

function selectHexOnBoard(hexIndex: number): void {
  selectedHexIndex = hexIndex;
  render();
}

function ensureLiveShell(): PersistentLiveShell {
  if (liveShell) return liveShell;
  if (!mapView) {
    mapView = createWargamesMap(selectHexOnBoard, () => {
      economyLens?.showSettledBoard();
      queueMicrotask(revealSettledEndgame);
    });
  }
  if (!inspectorView) inspectorView = createWargamesInspector();
  if (!economyView) economyView = createWargamesEconomy();
  if (!economyLens) economyLens = createEconomyLens(selectHexOnBoard, () => mapView?.isBoardSettled() ?? true);
  if (!diplomacyLog) diplomacyLog = createDiplomacyLog(displayedNotes);
  economyLens.attach(mapView.element);

  const wrap = el('div', 'wg-live-wrap');
  const factionStripSlot = el('div');
  const spotlightSlot = el('div');
  spotlightSlot.hidden = true;
  const endgameSlot = el('div', 'wg-live-wrap');
  endgameSlot.hidden = true;
  const mapPane = el('section', 'wg-map-pane');
  const stage = el('div', 'wg-map-stage');
  const boardBarSlot = el('div', 'wg-board-bar');
  const hexIntelSlot = el('div');

  const mapKey = buildMapKey();
  stage.append(boardBarSlot, economyLens.controls, mapView.element, mapView.caption, hexIntelSlot, mapKey.keySlot);
  mapPane.append(stage);
  wrap.append(factionStripSlot, spotlightSlot, endgameSlot, mapPane, diplomacyLog.element, economyView.element);
  liveShell = { wrap, factionStripSlot, spotlightSlot, endgameSlot, boardBarSlot, hexIntelSlot, mapKeyPopover: mapKey.legend };
  return liveShell;
}

function revealSettledEndgame(): void {
  if (!liveShell?.endgameSlot.hidden) return;
  const state = displayedMatchState();
  if (!state || !isMatchOver(state)) return;
  render();
}

function updateLiveShell(state: MatchState): HTMLElement {
  const snap = wargamesSnapshot();
  const shell = ensureLiveShell();

  shell.factionStripSlot.replaceChildren(buildFactionBannerStrip(state));
  shell.spotlightSlot.hidden = spotlightSeatId === null;
  if (spotlightSeatId !== null) {
    shell.spotlightSlot.replaceChildren(buildSpotlightBar(state, spotlightSeatId));
  }
  if (spotlightSeatId === null) {
    shell.spotlightSlot.replaceChildren();
  }

  mapView?.update(state, snap.pov, selectedHexIndex, spotlightSeatId);
  shell.mapKeyPopover.replaceChildren(...buildMapLegend(state.spec.rulesVersion).children);
  diplomacyLog?.update(state, snap.pov);
  economyView?.update(state, snap.events);
  economyLens?.update(state, snap.pov, selectedHexIndex);
  const isEndgameShown = isMatchOver(state) && (mapView?.isBoardSettled() ?? true);
  shell.endgameSlot.hidden = !isEndgameShown;
  if (isEndgameShown) {
    const endgameChildren: HTMLElement[] = [buildEndgameCard(state)];
    if (postgameReportMode === 'expanded' && inspectorView) {
      const analytics = displayedMatchAnalytics(state);
      inspectorView.update(state, analytics, spotlightSeatId);
      endgameChildren.push(inspectorView.element);
    }
    shell.endgameSlot.replaceChildren(...endgameChildren);
  }
  if (!isEndgameShown) {
    shell.endgameSlot.replaceChildren();
  }

  const selectedSeat = spotlightSeatId ? state.seats.find((seat) => seat.config.seatId === spotlightSeatId) : null;
  const modeHint = selectedSeat ? `Fog of war · ${selectedSeat.config.label} view` : 'Full map';
  const followStatus = followStatusOf(state, snap.headState ?? state);
  shell.boardBarSlot.replaceChildren(
    el('span', 'wg-board-hint', modeHint),
    el('span', 'wg-board-hint', goalText(state)),
    el('span', 'wg-board-hint', followStatus),
  );
  shell.hexIntelSlot.replaceChildren(buildHexIntelBar(state, snap.pov));
  return shell.wrap;
}

function followStatusOf(state: MatchState, headState: MatchState): string {
  if (state !== headState) return `Replay · Rules ${state.spec.rulesVersion}`;
  if (isActiveMatchStatus(state.status)) return `Live · Rules ${state.spec.rulesVersion}`;
  return `${state.status} · Rules ${state.spec.rulesVersion}`;
}

function standingGlyph(standing: SeatStanding, color: string): SVGSVGElement {
  if (standing.isPoints) return createWargamesGlyph(TROPHY_ICON_PATH, 12, color, 'Victory points toward the target');
  return createWargamesGlyph(WARGAMES_GLYPH_PATHS.territory, 12, color, 'Villages held toward victory');
}

function goalText(state: MatchState): string {
  const pointTarget = victoryPointTargetOf(state);
  if (pointTarget !== null) return `VP ${Math.max(0, ...Object.values(state.victoryPointsBySeat))} of ${pointTarget}`;
  const winVillages = seatStandingOf(state, state.seats[0].config.seatId).goal;
  const holdTurns = victoryHoldTurnsFor(state.spec);
  if (holdTurns <= 1) return `Goal ${winVillages} villages`;
  return `Goal ${winVillages} of ${villageCountOf(state)} villages, hold ${holdTurns} turns`;
}

function render(): void {
  if (!root || !isViewActive) return;
  const state = displayedMatchState();
  const snap = wargamesSnapshot();
  const shell = ensurePanelShell();
  if (shell.content.parentElement !== root) {
    root.replaceChildren(shell.content);
  }

  const subTabs = el('div', 'wg-subtabs');
  const tabDefs: readonly { id: WargamesSubTab; label: string }[] = [
    { id: 'live', label: 'Live Match' },
    { id: 'new', label: 'New Match' },
    { id: 'history', label: 'History & Elo' },
  ];
  for (const def of tabDefs) {
    const tabBtn = createPressable('wg-subtab', def.label);
    tabBtn.dataset.state = activeSubTab === def.id ? 'active' : 'idle';
    tabBtn.addEventListener('click', () => {
      activeSubTab = def.id;
      render();
    });
    subTabs.append(tabBtn);
  }

  const meta = el('div', 'wg-match-meta');
  if (state) {
    const track = ensureTurnTrack();
    track.update(turnTrackInputOf(state), state === snap.headState ? snap.phaseDeadline : null);
    meta.append(
      track.element,
      el('span', 'wg-match-title', state.spec.title),
    );
    const headStatus = snap.headState?.status ?? state.status;
    if (headStatus === 'running' || headStatus === 'seating') {
      meta.append(button({
        variant: 'danger',
        size: 'small',
        label: 'Abort match',
        onClick: () => {
          openConfirmDialog({
            title: 'Abort Wargames match',
            message: `Stop match ${state.matchId} now?`,
            confirmLabel: 'Abort match',
            danger: true,
            onConfirm: () => {
              void sendControlRequest('wargames-abort', { matchId: state.matchId }, { timeoutMs: 15_000 })
                .then((reply) => {
                  if (reply.type === 'wargames-abort-result' && !reply.ok) {
                    bannerMessage = reply.error ?? 'Could not abort match.';
                    render();
                  }
                })
                .catch((reason: unknown) => {
                  bannerMessage = `Could not abort match: ${formatError(reason)}`;
                  render();
                });
            },
          });
        },
      }));
    }
  }
  shell.header.replaceChildren(subTabs, meta);

  shell.banner.hidden = bannerMessage.length === 0;
  shell.banner.textContent = bannerMessage;

  if (activeSubTab === 'new') {
    if (mountedBodyMode !== 'new') {
      shell.body.replaceChildren(ensureNewMatchSection());
      mountedBodyMode = 'new';
    }
    return;
  }

  if (activeSubTab === 'history') {
    shell.body.replaceChildren(buildHistorySection());
    mountedBodyMode = 'history';
    return;
  }

  if (state) {
    const liveWrap = updateLiveShell(state);
    if (mountedBodyMode !== 'live') {
      shell.body.replaceChildren(liveWrap);
      mountedBodyMode = 'live';
    }
    return;
  }

  if (snap.watchedMatchId !== null && watchStreamState === 'loading') {
    const loadingBox = el('section', 'wg-form-section');
    loadingBox.append(el('p', 'wg-empty-copy', `Connecting to match ${snap.watchedMatchId}...`));
    shell.body.replaceChildren(loadingBox);
    mountedBodyMode = 'loading';
    return;
  }

  if (snap.watchedMatchId !== null && watchStreamState === 'failed') {
    const failedMatchId = snap.watchedMatchId;
    const failedBox = el('section', 'wg-form-section');
    failedBox.append(emptyState({
      title: 'Match stream unavailable',
      text: `Could not load match ${failedMatchId}.`,
      variant: 'boxed',
      actions: [
        button({
          variant: 'secondary',
          label: 'Load match',
          onClick: () => watchMatchById(failedMatchId, false),
        }),
      ],
    }));
    shell.body.replaceChildren(failedBox);
    mountedBodyMode = 'failed';
    return;
  }

  const wrapper = el('section', 'wg-form-section');
  wrapper.append(emptyState({
    title: 'No Wargames matches yet',
    text: 'Start a match to watch it live.',
    variant: 'boxed',
    actions: [
      button({
        variant: 'primary',
        label: 'New match',
        onClick: () => {
          activeSubTab = 'new';
          render();
        },
      }),
    ],
  }));
  shell.body.replaceChildren(wrapper);
  mountedBodyMode = 'empty';
}

function handleStoreUpdate(): void {
  if (wargamesSnapshot().headState !== null && watchStreamState !== 'idle') {
    watchStreamState = 'idle';
    bannerMessage = '';
  }
  if (ensureAutoWatch()) return;
  render();
}

setWargamesResyncRequester(subscribeMatchStream);

subscribeSettings((change) => {
  if (change.kind === 'broadcast') render();
});

export const view: ViewModule<HTMLElement> = {
  mount(panel) {
    root = panel;
    isViewActive = true;
    unsubscribe?.();
    unsubscribe = subscribeWargames(handleStoreUpdate);
    if (ensureAutoWatch()) return;
    render();
  },
  activate() {
    isViewActive = true;
    if (ensureAutoWatch()) return;
    render();
  },
  deactivate() {
    isViewActive = false;
  },
  refresh() {
    const watchedId = wargamesSnapshot().watchedMatchId;
    if (watchedId) {
      void subscribeMatchStream(watchedId);
      render();
      return;
    }
    if (ensureAutoWatch()) return;
    render();
  },
};
