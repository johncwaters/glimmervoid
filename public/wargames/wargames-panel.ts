import { WARGAMES_SEAT_IDS, WARGAMES_SQUEEZE_TICK, WARGAMES_WIN_VILLAGES } from '#shared/contracts/wargames.ts';
import type { SeatId, WargamesMatchSpec, WargamesMatchSummary } from '#shared/contracts/wargames.ts';
import { ALL_HEXES, projectSeatState } from '#shared/wargames/engine.ts';
import type { MatchState } from '#shared/wargames/engine.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { button } from '../ui/button.ts';
import { emptyState } from '../ui/empty-state.ts';
import { createPressable } from '../ui/pressable.ts';
import { segmented } from '../ui/segmented.ts';
import { select } from '../ui/select.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { createWargamesInspector } from './wargames-inspector.ts';
import { createWargamesMap, SEAT_COLORS } from './wargames-map.ts';
import './wargames-panel.css';
import {
  displayedMatchAnalytics,
  displayedMatchState,
  selectWatchedMatch,
  setWargamesPov,
  setWargamesScrubTick,
  subscribeWargames,
  wargamesSnapshot,
} from './wargames-store.ts';

type WargamesSubTab = 'live' | 'new' | 'history';
type MapVisibilityMode = 'god' | 'fog';
type WatchStreamState = 'idle' | 'loading' | 'failed';

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
let visibilityMode: MapVisibilityMode = 'god';
let watchStreamState: WatchStreamState = 'idle';
let bannerMessage = '';
let unsubscribe: (() => void) | null = null;
const failedAutoWatchIds = new Set<string>();

let mapView: ReturnType<typeof createWargamesMap> | null = null;
let inspectorView: ReturnType<typeof createWargamesInspector> | null = null;
let persistentNewMatchSection: HTMLElement | null = null;
let persistentScrubberRange: HTMLInputElement | null = null;
let persistentVisibilityToggle: ReturnType<typeof segmented<MapVisibilityMode>> | null = null;

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

function watchMatchById(matchId: string, switchToLive = true): void {
  const current = wargamesSnapshot().watchedMatchId;
  if (current && current !== matchId) sendControlMsg({ type: 'wargames-unwatch', matchId: current });
  failedAutoWatchIds.delete(matchId);
  bannerMessage = '';
  selectedHexIndex = null;
  spotlightSeatId = null;
  visibilityMode = 'god';
  setWargamesPov('god');
  selectWatchedMatch(matchId);
  if (switchToLive) activeSubTab = 'live';
  subscribeMatchStream(matchId);
  render();
}

function ensureAutoWatch(): boolean {
  if (!isViewActive) return false;
  const snap = wargamesSnapshot();
  const canSwitchFromFailed = watchStreamState === 'failed' && snap.headState === null;
  if (snap.watchedMatchId !== null && !canSwitchFromFailed) return false;
  const candidateId = pickAutoWatchMatchId();
  if (!candidateId || candidateId === snap.watchedMatchId) return false;
  watchMatchById(candidateId, false);
  return true;
}

function applyVisibilityMode(nextMode: MapVisibilityMode): void {
  visibilityMode = nextMode;
  if (nextMode === 'god') {
    setWargamesPov('god');
    render();
    return;
  }
  const state = displayedMatchState();
  const targetSeatId = spotlightSeatId ?? state?.seats[0]?.config.seatId ?? 's1';
  spotlightSeatId = targetSeatId;
  setWargamesPov(targetSeatId);
  render();
}

function ensureVisibilityToggle(): ReturnType<typeof segmented<MapVisibilityMode>> {
  if (persistentVisibilityToggle) return persistentVisibilityToggle;
  persistentVisibilityToggle = segmented<MapVisibilityMode>({
    label: 'Map visibility mode',
    size: 'small',
    value: visibilityMode,
    options: [
      { value: 'god', label: 'God View' },
      { value: 'fog', label: 'Seat Fog' },
    ],
    onChange: (nextMode) => applyVisibilityMode(nextMode),
  });
  return persistentVisibilityToggle;
}

function handleFactionBannerClick(seatId: SeatId): void {
  if (visibilityMode === 'fog') {
    spotlightSeatId = seatId;
    setWargamesPov(seatId);
    render();
    return;
  }
  spotlightSeatId = spotlightSeatId === seatId ? null : seatId;
  render();
}

function ensureNewMatchSection(): HTMLElement {
  if (persistentNewMatchSection) return persistentNewMatchSection;
  const section = el('section', 'wg-form-section');
  section.append(el('h2', 'wg-section-title', 'New 6-Seat Wargames Match'));
  const titleInput = el('input', 'wg-input') as HTMLInputElement;
  titleInput.value = 'Mixed-Model Research Match';
  const seedInput = el('input', 'wg-input') as HTMLInputElement;
  seedInput.type = 'number';
  seedInput.value = String(Math.floor(Math.random() * 900_000) + 100_000);

  const metaRow = el('div', 'wg-meta-inputs');
  metaRow.append(titleInput, seedInput);
  section.append(metaRow);

  const seatInputs: { seatId: SeatId; agentSelect: ReturnType<typeof select<string>>; modelInput: HTMLInputElement }[] = [];
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
    row.append(el('span', 'wg-seat-label', seatId.toUpperCase()), agentSelect.element, modelInput);
    section.append(row);
    seatInputs.push({ seatId, agentSelect, modelInput });
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
        title: titleInput.value.trim() || 'Wargames Match',
        seed: Math.max(1, Number(seedInput.value) || 424242),
        tickDeadlineSeconds: 60,
        maxTicks: 40,
        seats: seatInputs.map((entry, index) => ({
          seatId: entry.seatId,
          label: `Seat ${index + 1}`,
          controllerKind: 'local-agent',
          setup: { agent: entry.agentSelect.element.value, model: entry.modelInput.value.trim() || null, options: [], instructions: '' },
          modelDisplay: entry.modelInput.value.trim() || entry.agentSelect.element.value,
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

function ensureScrubberRange(): HTMLInputElement {
  if (persistentScrubberRange) return persistentScrubberRange;
  const range = el('input', 'wg-range') as HTMLInputElement;
  range.type = 'range';
  range.min = '0';
  range.addEventListener('input', () => {
    const headTick = wargamesSnapshot().headState?.tick ?? 0;
    const picked = Number(range.value);
    setWargamesScrubTick(picked >= headTick ? null : picked);
  });
  persistentScrubberRange = range;
  return range;
}

function buildFactionBannerStrip(state: MatchState): HTMLElement {
  const strip = el('div', 'wg-faction-strip');
  for (const seat of state.seats) {
    const seatId = seat.config.seatId;
    let ownedVillages = 0;
    let totalTroops = 0;
    let totalGrain = 0;
    let totalOre = 0;

    for (const village of state.villages) {
      if (!village || village.owner !== seatId) continue;
      ownedVillages += 1;
      totalTroops += village.troops.raider + village.troops.guard + village.troops.envoy;
      totalGrain += village.resources.grain;
      totalOre += village.resources.ore;
    }

    for (const army of state.armies.values()) {
      if (army.owner !== seatId) continue;
      if (army.status !== 'marching' && army.status !== 'returning') continue;
      totalTroops += army.troops.raider + army.troops.guard + army.troops.envoy;
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
    nameWrap.append(swatch, el('span', 'wg-faction-id', `${seatId.toUpperCase()} ${seat.config.label}`));
    head.append(nameWrap, el('span', 'wg-faction-villages', `${ownedVillages}/${WARGAMES_WIN_VILLAGES}`));

    const sub = el('div', 'wg-faction-sub', `${seat.config.modelDisplay} · ${seat.status}`);

    const track = el('div', 'wg-win-track');
    const fill = el('div', 'wg-win-fill');
    const winRatio = Math.min(100, Math.round((ownedVillages / WARGAMES_WIN_VILLAGES) * 100));
    fill.style.width = `${winRatio}%`;
    track.append(fill);

    const stats = el('div', 'wg-faction-stats');
    stats.append(
      el('span', '', `${totalTroops} trp`),
      el('span', '', `${totalGrain}G ${totalOre}O`),
    );

    banner.append(head, sub, track, stats);
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
  right.append(
    el('span', 'wg-hex-intel-stat', `Garrison: ${village.troops.raider}R / ${village.troops.guard}G / ${village.troops.envoy}E`),
    el('span', 'wg-hex-intel-stat', `Buildings: F${village.buildings.farm} M${village.buildings.mine} B${village.buildings.barracks} W${village.buildings.wall}`),
    el('span', 'wg-hex-intel-stat', `${village.resources.grain}G ${village.resources.ore}O`),
  );

  bar.append(left, right);
  return bar;
}

function buildMapLegend(): HTMLElement {
  const legend = el('div', 'wg-map-legend');
  legend.append(
    el('span', '', 'Tinted Hex = Territory'),
    el('span', '', 'Bottom Bar = Loyalty'),
    el('span', '', 'Dashed Arrow = Marching Army'),
    el('span', '', `Outer Ring = Barren @ Tick ${WARGAMES_SQUEEZE_TICK}`),
  );
  return legend;
}

function buildHistorySection(): HTMLElement {
  const { history, matches } = wargamesSnapshot();
  const wrapper = el('section', 'wg-history-grid');

  const eloBox = el('div', 'wg-form-section');
  eloBox.append(el('h2', 'wg-section-title', 'Model Elo Leaderboard'));
  if (history.eloByModel.length === 0) {
    eloBox.append(el('p', 'wg-empty-copy', 'Finish a match to populate model Elo ratings.'));
  }
  if (history.eloByModel.length > 0) {
    const table = el('table', 'wg-table');
    const headRow = el('tr');
    headRow.append(el('th', '', 'Model'), el('th', 'wg-num', 'Elo'), el('th', 'wg-num', 'Wins'), el('th', 'wg-num', 'Matches'), el('th', 'wg-num', 'Breaches'));
    table.append(el('thead', '', ''), el('tbody'));
    table.tHead?.append(headRow);
    const tbody = table.tBodies[0];
    for (const row of history.eloByModel) {
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
    matchMeta.append(
      el('div', 'wg-card-title', `${match.title} (${match.matchId})`),
      el('div', 'wg-card-meta', `${match.status} · Tick ${match.tick}/${match.maxTicks} · Winner: ${match.winnerModelDisplay ?? '-'} · Breaches: ${match.breachCount}`),
    );
    const watchBtn = button({
      variant: 'secondary',
      size: 'small',
      label: 'Watch',
      onClick: () => watchMatchById(match.matchId),
    });
    row.append(matchMeta, watchBtn);
    listBox.append(row);
  }

  wrapper.append(eloBox, listBox);
  return wrapper;
}

function buildLiveSection(state: ReturnType<typeof displayedMatchState>): HTMLElement {
  const snap = wargamesSnapshot();
  const analytics = displayedMatchAnalytics(state);

  if (!state && snap.watchedMatchId !== null && watchStreamState === 'loading') {
    const loadingBox = el('section', 'wg-form-section');
    loadingBox.append(el('p', 'wg-empty-copy', `Connecting to match ${snap.watchedMatchId}...`));
    return loadingBox;
  }

  if (!state && snap.watchedMatchId !== null && watchStreamState === 'failed') {
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
    return failedBox;
  }

  if (!state) {
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
    return wrapper;
  }

  const liveWrap = el('div', 'wg-live-wrap');
  liveWrap.append(buildFactionBannerStrip(state));

  const grid = el('div', 'wg-live-grid');
  const mapPane = el('section', 'wg-map-pane');

  const stage = el('div', 'wg-map-stage');
  const boardBar = el('div', 'wg-board-bar');
  const modeHint = visibilityMode === 'fog' && spotlightSeatId
    ? `FOG OF WAR · ${spotlightSeatId.toUpperCase()} VISION`
    : spotlightSeatId
      ? `SPOTLIGHT · ${spotlightSeatId.toUpperCase()} (CLICK AGAIN TO CLEAR)`
      : '37-HEX TACTICAL BOARD · CLICK FACTION TO SPOTLIGHT · CLICK HEX FOR INTEL';
  const followStatus = snap.scrubTick === null ? 'FOLLOWING LIVE' : `REPLAY · TICK ${snap.scrubTick}`;
  boardBar.append(el('span', 'wg-board-hint', modeHint), el('span', 'wg-board-hint', followStatus));

  if (!mapView) {
    mapView = createWargamesMap((hexIndex) => {
      selectedHexIndex = hexIndex;
      render();
    });
  }
  mapView.update(state, snap.pov, selectedHexIndex, spotlightSeatId);
  stage.append(boardBar, mapView.element, buildHexIntelBar(state, snap.pov), buildMapLegend());

  const headTick = snap.headState?.tick ?? state.tick;
  const scrubber = el('div', 'wg-scrubber');
  const range = ensureScrubberRange();
  range.max = String(Math.max(1, headTick));
  range.value = String(snap.scrubTick ?? headTick);
  scrubber.append(
    button({ variant: 'secondary', size: 'small', label: 'Previous tick', onClick: () => setWargamesScrubTick(Math.max(0, state.tick - 1)) }),
    range,
    button({ variant: 'secondary', size: 'small', label: 'Follow live', onClick: () => setWargamesScrubTick(null) }),
  );

  mapPane.append(stage, scrubber);

  if (!inspectorView) inspectorView = createWargamesInspector();
  inspectorView.update(state, analytics, spotlightSeatId);

  grid.append(mapPane, inspectorView.element);
  liveWrap.append(grid);
  return liveWrap;
}

function render(): void {
  if (!root || !isViewActive) return;
  const state = displayedMatchState();

  const header = el('header', 'wg-header');
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
    const toggle = ensureVisibilityToggle();
    toggle.setValue(visibilityMode);
    meta.append(
      statusBadge,
      el('span', 'wg-match-title', state.spec.title),
      toggle.element,
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
  header.append(subTabs, meta);

  const body = el('div', 'wg-body');
  if (bannerMessage) body.append(el('div', 'wg-form-status', bannerMessage));
  if (activeSubTab === 'live') body.append(buildLiveSection(state));
  if (activeSubTab === 'new') body.append(ensureNewMatchSection());
  if (activeSubTab === 'history') body.append(buildHistorySection());

  const content = el('div', 'wg-content');
  content.append(header, body);
  root.replaceChildren(content);
}

function handleStoreUpdate(): void {
  if (wargamesSnapshot().headState !== null && watchStreamState !== 'idle') {
    watchStreamState = 'idle';
    bannerMessage = '';
  }
  if (ensureAutoWatch()) return;
  render();
}

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
