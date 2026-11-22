import { AgentModelCatalog } from '#shared/contracts/agent-models.ts';
import { WARGAMES_RULES_VERSION, WARGAMES_SEAT_IDS, WARGAMES_SQUEEZE_TICK, WARGAMES_WIN_VILLAGES } from '#shared/contracts/wargames.ts';
import type { OrderItem, SeatId, SeatStatus, TickPhase, WargamesMatchSpec, WargamesMatchSummary } from '#shared/contracts/wargames.ts';
import { ALL_HEXES, projectSeatState } from '#shared/wargames/engine.ts';
import type { MatchState } from '#shared/wargames/engine.ts';
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
  TROPHY_ICON_PATH,
} from '../svg-dom.ts';
import { button } from '../ui/button.ts';
import { emptyState } from '../ui/empty-state.ts';
import { createPressable } from '../ui/pressable.ts';
import { select } from '../ui/select.ts';
import { textArea } from '../ui/text-input.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { createWargamesInspector } from './wargames-inspector.ts';
import { createWargamesMap, SEAT_COLORS, UNIT_GLYPH_PATHS } from './wargames-map.ts';
import './wargames-panel.css';
import {
  displayedMatchAnalytics,
  displayedMatchState,
  selectWatchedMatch,
  setWargamesPov,
  subscribeWargames,
  wargamesSnapshot,
} from './wargames-store.ts';

type WargamesSubTab = 'live' | 'new' | 'history';
type WatchStreamState = 'idle' | 'loading' | 'failed';
type PanelBodyMode = 'unmounted' | 'empty' | 'loading' | 'failed' | 'live' | 'new' | 'history';

interface PersistentLiveShell {
  readonly wrap: HTMLElement;
  readonly factionStripSlot: HTMLElement;
  readonly spotlightSlot: HTMLElement;
  readonly endgameSlot: HTMLElement;
  readonly boardBarSlot: HTMLElement;
  readonly hexIntelSlot: HTMLElement;
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
let unsubscribe: (() => void) | null = null;
const failedAutoWatchIds = new Set<string>();

let mapView: ReturnType<typeof createWargamesMap> | null = null;
let inspectorView: ReturnType<typeof createWargamesInspector> | null = null;
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

const WARGAMES_GLYPH_PATHS = Object.freeze({
  skull: 'M 4 7 A 4 4 0 1 1 12 7 V 10 H 10 V 13 H 6 V 10 H 4 Z M 6.5 7.5 H 6.6 M 9.5 7.5 H 9.6',
  scroll: 'M 4 3 H 12 V 13 H 4 Z M 6 6 H 10 M 6 9 H 9',
  crosshair: 'M 8 2 V 5 M 8 11 V 14 M 2 8 H 5 M 11 8 H 14 M 5 8 A 3 3 0 1 0 11 8 A 3 3 0 1 0 5 8',
  swords: 'M 3 13 L 12 4 M 10 3 L 13 3 L 13 6 M 13 13 L 4 4 M 6 3 L 3 3 L 3 6',
  clock: 'M 3 8 A 5 5 0 1 0 13 8 A 5 5 0 1 0 3 8 M 8 5 V 8 L 10 9.5',
  ready: 'M 5 8 A 3 3 0 1 0 11 8 A 3 3 0 1 0 5 8',
  offline: 'M 4 8 A 4 4 0 1 0 12 8 A 4 4 0 1 0 4 8 M 5 11 L 11 5',
  breach: 'M 8 2 L 14 13 H 2 Z M 8 6 V 9 M 8 11 V 11.5',
  grain: 'M 8 13 V 3 M 8 6 L 5 4 M 8 6 L 11 4 M 8 9 L 5 7 M 8 9 L 11 7',
  ore: 'M 8 2 L 13 6 L 11 13 H 5 L 3 6 Z',
});

const ACTING_PHASE_GLYPHS: Readonly<Record<TickPhase, string>> = Object.freeze({
  talk: CHAT_ICON_PATH,
  contracts: WARGAMES_GLYPH_PATHS.scroll,
  orders: WARGAMES_GLYPH_PATHS.crosshair,
  resolving: WARGAMES_GLYPH_PATHS.swords,
  reported: WARGAMES_GLYPH_PATHS.swords,
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
  grainChip.append(createWargamesGlyph(WARGAMES_GLYPH_PATHS.grain, 12, 'var(--state-waiting)', 'Grain'), el('span', '', String(grain)));
  const oreChip = el('span', 'wg-legend-item');
  oreChip.append(createWargamesGlyph(WARGAMES_GLYPH_PATHS.ore, 12, 'var(--text-dim)', 'Ore'), el('span', '', String(ore)));
  wrap.append(grainChip, oreChip);
  return wrap;
}

function buildUnitChips(troops: { raider: number; guard: number; envoy: number }, color: string): HTMLElement {
  const unitGroup = el('span', 'wg-faction-units');
  for (const unit of UNIT_GLYPH_PATHS) {
    const icon = createSvgIcon(10, 10);
    icon.removeAttribute('aria-hidden');
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', unit.label);
    icon.setAttribute('viewBox', '-4 -4 8 8');
    icon.append(createSvgShape('path', { d: unit.path, fill: color }));
    const chip = el('span', 'wg-legend-item');
    chip.append(icon, el('span', '', String(troops[unit.key])));
    unitGroup.append(chip);
  }
  return unitGroup;
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

function subscribeMatchStream(matchId: string): void {
  watchStreamState = 'loading';
  bannerMessage = '';
  void sendControlRequest('wargames-watch', { matchId }, { timeoutMs: 15_000 })
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

function watchMatchById(matchId: string, switchToLive = true, selectionMode: 'auto' | 'manual' = 'auto'): void {
  const current = wargamesSnapshot().watchedMatchId;
  if (current && current !== matchId) sendControlMsg({ type: 'wargames-unwatch', matchId: current });
  watchSelectionMode = selectionMode;
  failedAutoWatchIds.delete(matchId);
  bannerMessage = '';
  selectedHexIndex = null;
  spotlightSeatId = null;
  setWargamesPov('god');
  selectWatchedMatch(matchId);
  if (switchToLive) activeSubTab = 'live';
  subscribeMatchStream(matchId);
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
    el('h2', 'wg-section-title', 'New 6-Seat Wargames Match'),
    el('p', 'wg-form-status', 'Fixed system rules are always injected first and cannot be edited. Optional strategy below is pre-game only.'),
  );
  const titleInput = el('input', 'wg-input') as HTMLInputElement;
  titleInput.value = 'Mixed-Model Research Match';
  const seedInput = el('input', 'wg-input') as HTMLInputElement;
  seedInput.type = 'number';
  seedInput.value = String(Math.floor(Math.random() * 900_000) + 100_000);

  const metaRow = el('div', 'wg-meta-inputs');
  metaRow.append(titleInput, seedInput);
  section.append(metaRow);

  const seatInputs: {
    seatId: SeatId;
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
    row.append(el('span', 'wg-seat-label', seatId.toUpperCase()), agentSelect.element, modelInput, instructionsInput);
    section.append(row);
    seatInputs.push({ seatId, agentSelect, modelInput, instructionsInput });
  }

  const formStatus = el('div', 'wg-form-status', '');
  const startButton = button({
    variant: 'primary',
    label: 'Start match',
    onClick: () => {
      startButton.disabled = true;
      formStatus.textContent = 'Starting 6-seat match...';
      const spec: WargamesMatchSpec = {
        version: 1,
        rulesVersion: WARGAMES_RULES_VERSION,
        title: titleInput.value.trim() || 'Wargames Match',
        seed: Math.max(1, Number(seedInput.value) || 424242),
        tickDeadlineSeconds: 60,
        maxTicks: 40,
        seats: seatInputs.map((entry, index) => ({
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

function buildFactionBannerStrip(state: MatchState): HTMLElement {
  const strip = el('div', 'wg-faction-strip');
  for (const seat of state.seats) {
    const seatId = seat.config.seatId;
    let ownedVillages = 0;
    let totalRaiders = 0;
    let totalGuards = 0;
    let totalEnvoys = 0;
    let totalGrain = 0;
    let totalOre = 0;

    for (const village of state.villages) {
      if (!village || village.owner !== seatId) continue;
      ownedVillages += 1;
      totalRaiders += village.troops.raider;
      totalGuards += village.troops.guard;
      totalEnvoys += village.troops.envoy;
      totalGrain += village.resources.grain;
      totalOre += village.resources.ore;
    }

    for (const army of state.armies.values()) {
      if (army.owner !== seatId) continue;
      if (army.status !== 'marching' && army.status !== 'returning') continue;
      totalRaiders += army.troops.raider;
      totalGuards += army.troops.guard;
      totalEnvoys += army.troops.envoy;
    }

    const isEliminated = seat.status === 'eliminated';
    const banner = createPressable('wg-faction-banner');
    banner.style.setProperty('--wg-seat-color', SEAT_COLORS[seatId]);
    const isSelected = spotlightSeatId === seatId;
    const isDimmed = spotlightSeatId !== null && !isSelected;
    banner.dataset.state = isSelected ? 'active' : isDimmed ? 'dimmed' : 'idle';
    if (isEliminated) banner.dataset.eliminated = 'true';
    banner.setAttribute('aria-pressed', String(isSelected));
    banner.addEventListener('click', () => handleFactionBannerClick(seatId));

    const statusLabel = formatSeatStatusLabel(seat.status, state.phase, state.status);
    const statusIcon = createWargamesGlyph(
      seatStatusGlyphPath(seat.status, state.phase),
      13,
      SEAT_STATUS_TONES[seat.status],
      statusLabel,
    );

    const head = el('div', 'wg-faction-head');
    const nameWrap = el('span', 'wg-faction-name');
    const swatch = el('span', 'wg-faction-swatch');
    swatch.style.background = SEAT_COLORS[seatId];
    nameWrap.append(swatch, el('span', 'wg-faction-id', seat.config.label));
    const headRight = el('span', 'wg-faction-name');
    headRight.append(statusIcon, el('span', 'wg-faction-villages', `${ownedVillages}/${WARGAMES_WIN_VILLAGES}`));
    head.append(nameWrap, headRight);

    const agentAndModel = formatSeatAgentModel(seat.config.setup.agent, seat.config.setup.model, seat.config.modelDisplay);
    const modelLine = el('div', 'wg-faction-sub', agentAndModel);

    const track = el('div', 'wg-win-track');
    const fill = el('div', 'wg-win-fill');
    const winRatio = Math.min(100, Math.round((ownedVillages / WARGAMES_WIN_VILLAGES) * 100));
    fill.style.width = `${winRatio}%`;
    track.append(fill);

    const troopCounts = { raider: totalRaiders, guard: totalGuards, envoy: totalEnvoys };
    const stats = el('div', 'wg-faction-stats');
    stats.append(buildUnitChips(troopCounts, SEAT_COLORS[seatId]), buildResourceReadout(totalGrain, totalOre));

    banner.append(head, modelLine, track, stats);
    strip.append(banner);
  }
  return strip;
}

function capitalizeWord(word: string): string {
  if (word.length === 0) return word;
  return `${word[0].toUpperCase()}${word.slice(1)}`;
}

function formatTroopBreakdown(troops: { raider: number; guard: number; envoy: number }): string {
  const parts: string[] = [];
  if (troops.raider > 0) parts.push(`${troops.raider}R`);
  if (troops.guard > 0) parts.push(`${troops.guard}G`);
  if (troops.envoy > 0) parts.push(`${troops.envoy}E`);
  return parts.join(' ');
}

function formatOrder(order: OrderItem): string {
  switch (order.kind) {
    case 'build':
      return `Build ${capitalizeWord(order.building)} @#${order.hexIndex}`;
    case 'train':
      return `Train ${order.count} ${capitalizeWord(order.troop)} @#${order.hexIndex}`;
    case 'march': {
      const troopSummary = formatTroopBreakdown(order.troops);
      return troopSummary
        ? `March #${order.fromHexIndex}->#${order.toHexIndex} (${troopSummary})`
        : `March #${order.fromHexIndex}->#${order.toHexIndex}`;
    }
    case 'scout':
      return `Scout #${order.fromHexIndex}->#${order.toHexIndex}`;
    case 'tribe_join':
      return `Join tribe ${order.partner.toUpperCase()}`;
    case 'tribe_leave':
      return 'Leave tribe';
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
  const tribeTag = tribePartner ? ` · Tribe ${tribePartner.toUpperCase()}` : '';
  titleWrap.append(
    swatch,
    el('span', 'wg-card-title', `${seatId.toUpperCase()} ${seat.config.label}`),
    el('span', 'wg-card-meta', `${agentAndModel} · ${formatSeatStatusLabel(seat.status, state.phase, state.status)}${tribeTag}`),
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
  const saidText = recentMessages.length > 0
    ? recentMessages
      .map((message) => (message.to ? `[T${message.tick} -> ${message.to.toUpperCase()}] ${message.text}` : `[T${message.tick}] ${message.text}`))
      .join(' | ')
    : 'No messages yet.';
  const saidCol = el('div', 'wg-dm-box');
  saidCol.append(el('div', 'wg-dm-label', 'Messages'), el('div', 'wg-dm-text', saidText));

  const tickOrders = state.ordersByTick[state.tick] ?? state.ordersByTick[Math.max(1, state.tick - 1)];
  const orders = seat.sealedOrders.length > 0 ? seat.sealedOrders : (tickOrders?.[seatId] ?? []);
  const activeContracts = [...state.contracts.values()]
    .filter((contract) => contract.status === 'active' && (contract.proposer === seatId || contract.counterparty === seatId))
    .map((contract) => {
      const other = contract.proposer === seatId ? contract.counterparty : contract.proposer;
      return `${contract.terms.kind.toUpperCase()} w/ ${other.toUpperCase()}`;
    });
  const ordersParts: string[] = [];
  if (orders.length > 0) ordersParts.push(orders.map(formatOrder).join(', '));
  if (activeContracts.length > 0) ordersParts.push(`Pacts: ${activeContracts.join(', ')}`);
  const ordersCol = el('div', 'wg-dm-box');
  ordersCol.append(
    el('div', 'wg-dm-label', 'Orders & contracts'),
    el('div', 'wg-dm-text', ordersParts.length > 0 ? ordersParts.join(' · ') : 'Hold'),
  );

  const grid = el('div', 'wg-spotlight-grid');
  grid.append(noteCol, saidCol, ordersCol);
  bar.append(head, grid);
  return bar;
}

function buildEndgameCard(state: MatchState): HTMLElement {
  const card = el('section', 'wg-endgame-card');
  const winnerSeat = state.winnerSeatId
    ? state.seats.find((seat) => seat.config.seatId === state.winnerSeatId) ?? null
    : null;
  const winnerColor = state.winnerSeatId ? SEAT_COLORS[state.winnerSeatId] : 'var(--border-hover)';
  card.style.borderColor = winnerColor;

  const villagesBySeat = new Map<SeatId, number>();
  const breachesBySeat = new Map<SeatId, number>();
  for (const seatId of WARGAMES_SEAT_IDS) {
    villagesBySeat.set(seatId, 0);
    breachesBySeat.set(seatId, 0);
  }
  for (const village of state.villages) {
    if (!village || village.owner === null) continue;
    villagesBySeat.set(village.owner, (villagesBySeat.get(village.owner) ?? 0) + 1);
  }
  for (const entry of state.ledger) {
    breachesBySeat.set(entry.breacher, (breachesBySeat.get(entry.breacher) ?? 0) + 1);
  }

  const head = el('div', 'wg-endgame-head');
  const winnerWrap = el('div', 'wg-endgame-winner');
  const emblem = createWargamesGlyph(
    state.status === 'aborted' ? WARGAMES_GLYPH_PATHS.breach : TROPHY_ICON_PATH,
    20,
    winnerColor,
    state.status === 'aborted' ? 'Aborted' : 'Winner',
  );
  const titleGroup = el('div', 'wg-endgame-titles');
  const headingText = winnerSeat
    ? `${winnerSeat.config.label} · ${villagesBySeat.get(winnerSeat.config.seatId) ?? 0}/${WARGAMES_WIN_VILLAGES}`
    : state.status === 'aborted'
      ? 'Match aborted'
      : 'Match finished';
  const heading = el('div', 'wg-endgame-title', headingText);
  const subtitleParts = [
    ...(winnerSeat
      ? [formatSeatAgentModel(winnerSeat.config.setup.agent, winnerSeat.config.setup.model, winnerSeat.config.modelDisplay)]
      : []),
    state.spec.rulesVersion,
    `Tick ${state.tick}/${state.spec.maxTicks}`,
  ];
  const sub = el('div', 'wg-card-meta', subtitleParts.join(' · '));
  titleGroup.append(heading, sub);
  winnerWrap.append(emblem, titleGroup);

  const actions = el('div', 'wg-endgame-actions');
  actions.append(button({
    variant: 'primary',
    size: 'small',
    label: 'New match',
    onClick: () => {
      activeSubTab = 'new';
      render();
    },
  }));
  head.append(winnerWrap, actions);

  const ranked = [...state.seats].sort((left, right) => {
    const leftCount = villagesBySeat.get(left.config.seatId) ?? 0;
    const rightCount = villagesBySeat.get(right.config.seatId) ?? 0;
    if (rightCount !== leftCount) return rightCount - leftCount;
    if (left.config.seatId === state.winnerSeatId) return -1;
    if (right.config.seatId === state.winnerSeatId) return 1;
    return 0;
  });

  const standings = el('div', 'wg-endgame-standings');
  for (let index = 0; index < ranked.length; index += 1) {
    const seat = ranked[index];
    const seatId = seat.config.seatId;
    const held = villagesBySeat.get(seatId) ?? 0;
    const breaches = breachesBySeat.get(seatId) ?? 0;
    const row = el('div', 'wg-endgame-row');
    if (seat.status === 'eliminated') row.dataset.eliminated = 'true';

    const leftSide = el('span', 'wg-faction-name');
    const swatch = el('span', 'wg-faction-swatch');
    swatch.style.background = SEAT_COLORS[seatId];
    leftSide.append(
      el('span', 'wg-card-meta', `#${index + 1}`),
      swatch,
      el('span', 'wg-faction-id', seat.config.label),
      el('span', 'wg-card-meta', formatSeatAgentModel(seat.config.setup.agent, seat.config.setup.model, seat.config.modelDisplay)),
    );

    const rightSide = el('span', 'wg-faction-units');
    if (seat.status === 'eliminated') {
      rightSide.append(createWargamesGlyph(WARGAMES_GLYPH_PATHS.skull, 13, 'var(--state-failed)', 'Eliminated'));
    }
    if (breaches > 0) {
      const breachChip = el('span', 'wg-legend-item');
      breachChip.append(
        createWargamesGlyph(WARGAMES_GLYPH_PATHS.breach, 12, 'var(--state-waiting)', 'Breaches'),
        el('span', '', String(breaches)),
      );
      rightSide.append(breachChip);
    }
    rightSide.append(el('span', 'wg-faction-villages', `${held}/${WARGAMES_WIN_VILLAGES}`));
    row.append(leftSide, rightSide);
    standings.append(row);
  }

  card.append(head, standings);
  return card;
}

function buildHexIntelBar(state: MatchState, pov: ReturnType<typeof wargamesSnapshot>['pov']): HTMLElement {
  const bar = el('div', 'wg-hex-intel');
  if (selectedHexIndex === null) {
    bar.append(
      el('span', 'wg-hex-intel-lead', 'HEX'),
      el('span', 'wg-card-meta', 'Select a hex'),
    );
    return bar;
  }

  const tile = ALL_HEXES[selectedHexIndex];
  const seatView = pov === 'god' ? null : projectSeatState(state, pov);
  const village = seatView
    ? seatView.visibleVillages.find((entry) => entry.hexIndex === selectedHexIndex) ?? null
    : state.villages[selectedHexIndex];
  const isFogged = seatView !== null && state.villages[selectedHexIndex] !== null && village === null;

  if (isFogged) {
    bar.append(
      el('span', 'wg-hex-intel-lead', `#${tile.index}`),
      el('span', 'wg-card-meta', `Fog · ${pov.toUpperCase()}`),
    );
    return bar;
  }

  if (!village) {
    bar.append(
      el('span', 'wg-hex-intel-lead', `#${tile.index}`),
      el('span', 'wg-card-meta', `R${tile.ring} (${tile.q}, ${tile.r})`),
    );
    return bar;
  }

  const left = el('div', 'wg-hex-intel-group');
  left.append(el('span', 'wg-hex-intel-lead', `#${tile.index}`));
  if (village.owner !== null) {
    const ownerSeat = state.seats.find((seat) => seat.config.seatId === village.owner);
    const swatch = el('span', 'wg-faction-swatch');
    swatch.style.background = SEAT_COLORS[village.owner];
    const ownerName = ownerSeat ? ownerSeat.config.label : village.owner.toUpperCase();
    const ownerTag = el('span', 'wg-hex-intel-owner', ownerName);
    ownerTag.style.color = SEAT_COLORS[village.owner];
    left.append(swatch, ownerTag);
  }
  if (village.owner === null) {
    left.append(el('span', 'wg-hex-intel-owner', 'BARB'));
  }
  const productionTag = village.productionState === 'barren' ? ' · BARREN' : '';
  left.append(el('span', 'wg-card-meta', `${village.loyalty}%${productionTag}`));

  const right = el('div', 'wg-hex-intel-group');
  const unitColor = village.owner !== null ? SEAT_COLORS[village.owner] : 'var(--text-dim)';
  right.append(
    buildUnitChips(village.troops, unitColor),
    el('span', 'wg-hex-intel-stat', `F${village.buildings.farm} M${village.buildings.mine} B${village.buildings.barracks} W${village.buildings.wall}`),
    buildResourceReadout(village.resources.grain, village.resources.ore),
  );

  bar.append(left, right);
  return bar;
}

function legendItem(icon: SVGSVGElement, label: string): HTMLElement {
  const item = el('span', 'wg-legend-item');
  item.append(icon, el('span', '', label));
  return item;
}

function buildMapLegend(): HTMLElement {
  const legend = el('div', 'wg-map-legend');
  for (const unit of UNIT_GLYPH_PATHS) {
    const icon = createSvgIcon(12, 12);
    icon.setAttribute('viewBox', '-4 -4 8 8');
    icon.append(createSvgShape('path', { d: unit.path, fill: 'var(--text-head)' }));
    legend.append(legendItem(icon, unit.label));
  }

  const territoryIcon = createSvgIcon(12, 12);
  territoryIcon.append(createSvgShape('polygon', {
    points: '6,1 11,3.5 11,8.5 6,11 1,8.5 1,3.5',
    fill: 'color-mix(in srgb, var(--accent) 28%, var(--bg-card))',
    stroke: 'var(--accent)',
    'stroke-width': '1.2',
  }));
  legend.append(legendItem(territoryIcon, 'Territory'));

  const loyaltyIcon = createSvgIcon(14, 12);
  loyaltyIcon.append(
    createSvgShape('rect', { x: '1', y: '5', width: '12', height: '3', fill: 'var(--bg)' }),
    createSvgShape('rect', { x: '1', y: '5', width: '8', height: '3', fill: 'var(--state-running)' }),
  );
  legend.append(legendItem(loyaltyIcon, 'Loyalty'));

  const marchIcon = createSvgIcon(16, 12);
  marchIcon.append(
    createSvgShape('line', {
      x1: '1',
      y1: '6',
      x2: '11',
      y2: '6',
      stroke: 'var(--text-head)',
      'stroke-width': '1.6',
      'stroke-dasharray': '3 2',
    }),
    createSvgShape('polygon', { points: '10,3 15,6 10,9', fill: 'var(--text-head)' }),
  );
  legend.append(legendItem(marchIcon, 'Marching'));

  const barrenIcon = createSvgIcon(12, 12);
  barrenIcon.append(createSvgShape('polygon', {
    points: '6,1 11,3.5 11,8.5 6,11 1,8.5 1,3.5',
    fill: 'var(--bg)',
    stroke: 'var(--text-muted)',
    'stroke-width': '1.1',
    'stroke-dasharray': '2 2',
  }));
  legend.append(legendItem(barrenIcon, `Barren @ T${WARGAMES_SQUEEZE_TICK}`));
  return legend;
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
      el('div', 'wg-card-meta', `${match.rulesVersion} · ${match.status} · Tick ${match.tick}/${match.maxTicks} · Winner: ${match.winnerModelDisplay ?? '-'} · Breaches: ${match.breachCount}${strategyTag}`),
    );
    const watchBtn = button({
      variant: 'secondary',
      size: 'small',
      label: 'Watch',
      onClick: () => watchMatchById(match.matchId, true, isActiveMatchStatus(match.status) ? 'auto' : 'manual'),
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

function ensureLiveShell(): PersistentLiveShell {
  if (liveShell) return liveShell;
  if (!mapView) {
    mapView = createWargamesMap((hexIndex) => {
      selectedHexIndex = hexIndex;
      render();
    });
  }
  if (!inspectorView) inspectorView = createWargamesInspector();

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

  stage.append(boardBarSlot, mapView.element, hexIntelSlot, buildMapLegend());
  mapPane.append(stage);
  wrap.append(factionStripSlot, spotlightSlot, endgameSlot, mapPane);
  liveShell = { wrap, factionStripSlot, spotlightSlot, endgameSlot, boardBarSlot, hexIntelSlot };
  return liveShell;
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

  const isEnded = state.status === 'finished' || state.status === 'aborted';
  shell.endgameSlot.hidden = !isEnded;
  if (isEnded) {
    const analytics = displayedMatchAnalytics(state);
    inspectorView?.update(state, analytics, spotlightSeatId);
    const endgameChildren: HTMLElement[] = [buildEndgameCard(state)];
    if (inspectorView) endgameChildren.push(inspectorView.element);
    shell.endgameSlot.replaceChildren(...endgameChildren);
  }
  if (!isEnded) {
    shell.endgameSlot.replaceChildren();
  }

  const selectedSeat = spotlightSeatId ? state.seats.find((seat) => seat.config.seatId === spotlightSeatId) : null;
  const modeHint = selectedSeat ? `FOG · ${selectedSeat.config.label.toUpperCase()}` : 'FULL MAP';
  const followStatus = isActiveMatchStatus(state.status)
    ? `LIVE · ${state.spec.rulesVersion}`
    : `${state.status.toUpperCase()} · ${state.spec.rulesVersion}`;
  shell.boardBarSlot.replaceChildren(el('span', 'wg-board-hint', modeHint), el('span', 'wg-board-hint', followStatus));

  mapView?.update(state, snap.pov, selectedHexIndex, spotlightSeatId);
  shell.hexIntelSlot.replaceChildren(buildHexIntelBar(state, snap.pov));
  return shell.wrap;
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
    const isLive = isActiveMatchStatus(state.status);
    const statusLabel = isLive ? 'LIVE' : state.status.toUpperCase();
    const statusBadge = el('span', 'wg-badge', `${statusLabel} · TICK ${state.tick}/${state.spec.maxTicks} · ${state.phase.toUpperCase()}`);
    statusBadge.dataset.tone = isLive ? 'live' : 'done';
    meta.append(
      statusBadge,
      el('span', 'wg-match-title', state.spec.title),
    );
    if (state.status === 'running' || state.status === 'seating') {
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
    text: 'Start a new 6-seat match to spectate live.',
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
      subscribeMatchStream(watchedId);
      render();
      return;
    }
    if (ensureAutoWatch()) return;
    render();
  },
};
