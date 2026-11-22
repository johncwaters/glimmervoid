import { AgentModelCatalog } from '#shared/contracts/agent-models.ts';
import { WARGAMES_RULES_VERSION, WARGAMES_SEAT_IDS, WARGAMES_SQUEEZE_TICK, WARGAMES_WIN_VILLAGES } from '#shared/contracts/wargames.ts';
import type { SeatId, SeatStatus, TickPhase, WargamesMatchSpec, WargamesMatchSummary } from '#shared/contracts/wargames.ts';
import { ALL_HEXES, projectSeatState } from '#shared/wargames/engine.ts';
import type { MatchState } from '#shared/wargames/engine.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { settingsPayloadSnapshot, subscribeSettings } from '../settings/settings-store.ts';
import { createSvgIcon, createSvgShape } from '../svg-dom.ts';
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

function formatSeatStatusLabel(status: SeatStatus, phase: TickPhase, matchStatus: MatchState['status']): string {
  if (status === 'acting') return ACTING_PHASE_LABELS[phase];
  if (status === 'disconnected' && matchStatus !== 'seating' && matchStatus !== 'lobby') return 'Offline';
  return SEAT_STATUS_LABELS[status];
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

    const banner = createPressable('wg-faction-banner');
    banner.style.setProperty('--wg-seat-color', SEAT_COLORS[seatId]);
    const isSelected = spotlightSeatId === seatId;
    const isDimmed = spotlightSeatId !== null && !isSelected;
    banner.dataset.state = isSelected ? 'active' : isDimmed ? 'dimmed' : 'idle';
    banner.setAttribute('aria-pressed', String(isSelected));
    banner.addEventListener('click', () => handleFactionBannerClick(seatId));

    const head = el('div', 'wg-faction-head');
    const nameWrap = el('span', 'wg-faction-name');
    const swatch = el('span', 'wg-faction-swatch');
    swatch.style.background = SEAT_COLORS[seatId];
    nameWrap.append(swatch, el('span', 'wg-faction-id', seat.config.label));
    head.append(nameWrap, el('span', 'wg-faction-villages', `${ownedVillages}/${WARGAMES_WIN_VILLAGES}`));

    const agentAndModel = formatSeatAgentModel(seat.config.setup.agent, seat.config.setup.model, seat.config.modelDisplay);
    const modelLine = el('div', 'wg-faction-sub', agentAndModel);
    const statusLine = el('div', 'wg-faction-sub', formatSeatStatusLabel(seat.status, state.phase, state.status));

    const track = el('div', 'wg-win-track');
    const fill = el('div', 'wg-win-fill');
    const winRatio = Math.min(100, Math.round((ownedVillages / WARGAMES_WIN_VILLAGES) * 100));
    fill.style.width = `${winRatio}%`;
    track.append(fill);

    const troopCounts = { raider: totalRaiders, guard: totalGuards, envoy: totalEnvoys };
    const unitGroup = el('span', 'wg-faction-units');
    for (const unit of UNIT_GLYPH_PATHS) {
      const icon = createSvgIcon(10, 10);
      icon.setAttribute('viewBox', '-4 -4 8 8');
      icon.append(createSvgShape('path', { d: unit.path, fill: SEAT_COLORS[seatId] }));
      const chip = el('span', 'wg-legend-item');
      chip.append(icon, el('span', '', String(troopCounts[unit.key])));
      unitGroup.append(chip);
    }

    const stats = el('div', 'wg-faction-stats');
    stats.append(unitGroup, el('span', '', `${totalGrain}G ${totalOre}O`));

    banner.append(head, modelLine, statusLine, track, stats);
    strip.append(banner);
  }
  return strip;
}

function buildHexIntelBar(state: MatchState, pov: ReturnType<typeof wargamesSnapshot>['pov']): HTMLElement {
  const bar = el('div', 'wg-hex-intel');
  if (selectedHexIndex === null) {
    bar.append(
      el('span', 'wg-hex-intel-lead', 'HEX INTEL'),
      el('span', 'wg-card-meta', 'Click any hex on the map to inspect owner, loyalty, garrison, buildings, and resources.'),
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
      el('span', 'wg-hex-intel-lead', `HEX #${tile.index}`),
      el('span', 'wg-card-meta', `Ring ${tile.ring} · Fog of War (outside ${pov.toUpperCase()} vision)`),
    );
    return bar;
  }

  if (!village) {
    const ringNote = tile.ring === 3 ? ` · Outer ring (barren @ tick ${WARGAMES_SQUEEZE_TICK})` : '';
    bar.append(
      el('span', 'wg-hex-intel-lead', `HEX #${tile.index}`),
      el('span', 'wg-card-meta', `Open terrain · Ring ${tile.ring} (${tile.q}, ${tile.r})${ringNote}`),
    );
    return bar;
  }

  const left = el('div', 'wg-hex-intel-group');
  left.append(el('span', 'wg-hex-intel-lead', `HEX #${tile.index}`));
  if (village.owner !== null) {
    const ownerSeat = state.seats.find((seat) => seat.config.seatId === village.owner);
    const swatch = el('span', 'wg-faction-swatch');
    swatch.style.background = SEAT_COLORS[village.owner];
    const ownerName = ownerSeat ? `${village.owner.toUpperCase()} ${ownerSeat.config.label}` : village.owner.toUpperCase();
    const ownerTag = el('span', 'wg-hex-intel-owner', ownerName);
    ownerTag.style.color = SEAT_COLORS[village.owner];
    left.append(swatch, ownerTag);
  }
  if (village.owner === null) {
    left.append(el('span', 'wg-hex-intel-owner', 'Barbarian Fort'));
  }
  const productionTag = village.productionState === 'barren' ? ' · BARREN' : '';
  left.append(el('span', 'wg-card-meta', `Loyalty ${village.loyalty}%${productionTag}`));

  const right = el('div', 'wg-hex-intel-group');
  const raiderText = `${village.troops.raider} ${village.troops.raider === 1 ? 'Raider' : 'Raiders'}`;
  const guardText = `${village.troops.guard} ${village.troops.guard === 1 ? 'Guard' : 'Guards'}`;
  const envoyText = `${village.troops.envoy} ${village.troops.envoy === 1 ? 'Envoy' : 'Envoys'}`;
  right.append(
    el('span', 'wg-hex-intel-stat', `${raiderText} · ${guardText} · ${envoyText}`),
    el('span', 'wg-hex-intel-stat', `Buildings: F${village.buildings.farm} M${village.buildings.mine} B${village.buildings.barracks} W${village.buildings.wall}`),
    el('span', 'wg-hex-intel-stat', `${village.resources.grain}G ${village.resources.ore}O`),
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
  const grid = el('div', 'wg-live-grid');
  const mapPane = el('section', 'wg-map-pane');
  const stage = el('div', 'wg-map-stage');
  const boardBarSlot = el('div', 'wg-board-bar');
  const hexIntelSlot = el('div');

  stage.append(boardBarSlot, mapView.element, hexIntelSlot, buildMapLegend());
  mapPane.append(stage);
  grid.append(mapPane, inspectorView.element);
  wrap.append(factionStripSlot, grid);
  liveShell = { wrap, factionStripSlot, boardBarSlot, hexIntelSlot };
  return liveShell;
}

function updateLiveShell(state: MatchState): HTMLElement {
  const snap = wargamesSnapshot();
  const analytics = displayedMatchAnalytics(state);
  const shell = ensureLiveShell();

  shell.factionStripSlot.replaceChildren(buildFactionBannerStrip(state));
  const selectedSeat = spotlightSeatId ? state.seats.find((seat) => seat.config.seatId === spotlightSeatId) : null;
  const modeHint = selectedSeat
    ? `FOG OF WAR · ${selectedSeat.config.label.toUpperCase()} (CLICK AGAIN FOR FULL MAP)`
    : '37-HEX TACTICAL BOARD · CLICK A FACTION FOR FOG OF WAR · CLICK A HEX FOR INTEL';
  const followStatus = isActiveMatchStatus(state.status) ? 'FOLLOWING LIVE' : `${state.status.toUpperCase()} · ${state.spec.rulesVersion}`;
  shell.boardBarSlot.replaceChildren(el('span', 'wg-board-hint', modeHint), el('span', 'wg-board-hint', followStatus));

  mapView?.update(state, snap.pov, selectedHexIndex, spotlightSeatId);
  shell.hexIntelSlot.replaceChildren(buildHexIntelBar(state, snap.pov));
  inspectorView?.update(state, analytics, spotlightSeatId);
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
