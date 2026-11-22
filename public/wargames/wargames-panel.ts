import { WARGAMES_SEAT_IDS } from '#shared/contracts/wargames.ts';
import type { SeatId, WargamesMatchSpec } from '#shared/contracts/wargames.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import { button } from '../ui/button.ts';
import { createPressable } from '../ui/pressable.ts';
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
let bannerMessage = '';
let unsubscribe: (() => void) | null = null;

let mapView: ReturnType<typeof createWargamesMap> | null = null;
let inspectorView: ReturnType<typeof createWargamesInspector> | null = null;
let persistentNewMatchSection: HTMLElement | null = null;
let persistentScrubberRange: HTMLInputElement | null = null;

function formatError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function subscribeMatchStream(matchId: string): void {
  void sendControlRequest('wargames-watch', { matchId }, { timeoutMs: 15_000 })
    .then((reply) => {
      if (reply.type === 'wargames-watch-result' && !reply.ok) {
        bannerMessage = reply.error ?? 'Could not load match log.';
        render();
      }
    })
    .catch((reason: unknown) => {
      bannerMessage = `Could not watch match: ${formatError(reason)}`;
      render();
    });
}

function watchMatchById(matchId: string): void {
  const current = wargamesSnapshot().watchedMatchId;
  if (current && current !== matchId) sendControlMsg({ type: 'wargames-unwatch', matchId: current });
  bannerMessage = '';
  selectWatchedMatch(matchId);
  activeSubTab = 'live';
  subscribeMatchStream(matchId);
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

  if (!state) {
    const empty = el('section', 'wg-form-section');
    empty.append(
      el('h2', 'wg-section-title', 'No Match Selected'),
      el('p', 'wg-empty-copy', snap.matches.length > 0 ? 'Pick a match from History & Elo or start a new 6-seat match.' : 'Start a new 6-seat match to spectate live.'),
    );
    if (snap.matches.length > 0) {
      empty.append(button({
        variant: 'primary',
        label: 'Watch latest',
        onClick: () => watchMatchById(snap.matches[0].matchId),
      }));
    }
    return empty;
  }

  const grid = el('div', 'wg-live-grid');
  const mapPane = el('section', 'wg-map-pane');

  const povBar = el('div', 'wg-pov-bar');
  const godBtn = createPressable('wg-pov-pill', 'God View');
  godBtn.dataset.state = snap.pov === 'god' ? 'active' : 'idle';
  godBtn.addEventListener('click', () => setWargamesPov('god'));
  povBar.append(godBtn);
  for (const seat of state.seats) {
    const pill = createPressable('wg-pov-pill', `${seat.config.seatId.toUpperCase()} · ${seat.config.modelDisplay}`);
    pill.dataset.state = snap.pov === seat.config.seatId ? 'active' : 'idle';
    const dot = el('span', 'wg-dot');
    dot.style.background = SEAT_COLORS[seat.config.seatId];
    pill.prepend(dot);
    pill.addEventListener('click', () => setWargamesPov(seat.config.seatId));
    povBar.append(pill);
  }

  if (!mapView) {
    mapView = createWargamesMap((hexIndex) => {
      selectedHexIndex = hexIndex;
      render();
    });
  }
  mapView.update(state, snap.pov, selectedHexIndex);
  const stage = el('div', 'wg-map-stage');
  stage.append(mapView.element);

  const seatStrip = el('div', 'wg-seat-strip');
  for (const seat of state.seats) {
    const ownedCount = state.villages.filter((village) => village !== null && village.owner === seat.config.seatId).length;
    const tile = el('div', 'wg-seat-stat');
    tile.append(
      el('div', 'wg-card-title', `${seat.config.seatId.toUpperCase()} · ${ownedCount} vil`),
      el('div', 'wg-card-meta', seat.config.modelDisplay),
      el('div', 'wg-card-meta', seat.status),
    );
    seatStrip.append(tile);
  }

  const headTick = snap.headState?.tick ?? state.tick;
  const scrubber = el('div', 'wg-scrubber');
  const range = ensureScrubberRange();
  range.max = String(Math.max(1, headTick));
  range.value = String(snap.scrubTick ?? headTick);
  scrubber.append(
    button({ variant: 'secondary', size: 'small', label: 'Previous tick', onClick: () => setWargamesScrubTick(Math.max(0, state.tick - 1)) }),
    button({ variant: 'secondary', size: 'small', label: 'Follow live', onClick: () => setWargamesScrubTick(null) }),
    range,
    el('span', 'wg-card-meta', `Tick ${state.tick} / ${state.spec.maxTicks} · ${state.phase.toUpperCase()}`),
  );

  mapPane.append(povBar, stage, seatStrip, scrubber);

  if (!inspectorView) inspectorView = createWargamesInspector();
  inspectorView.update(state, analytics);

  grid.append(mapPane, inspectorView.element);
  return grid;
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
    meta.append(
      el('span', 'wg-badge', `${state.status.toUpperCase()} · TICK ${state.tick}/${state.spec.maxTicks}`),
      el('span', 'wg-card-meta', `Seed ${state.spec.seed}`),
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

export const view: ViewModule<HTMLElement> = {
  mount(panel) {
    root = panel;
    isViewActive = true;
    unsubscribe?.();
    unsubscribe = subscribeWargames(render);
    render();
  },
  activate() {
    isViewActive = true;
    render();
  },
  deactivate() {
    isViewActive = false;
  },
  refresh() {
    const watchedId = wargamesSnapshot().watchedMatchId;
    if (watchedId) subscribeMatchStream(watchedId);
    render();
  },
};
