import type { JudgeRow, RaceContestant, RaceHistory, RaceRecord, StandingRow } from '#shared/contracts/race.ts';
import { RACE_CRITERIA } from '#shared/contracts/race.ts';
import { REMOVED_CONTESTANT, seriesKey, seriesStanding, winnerNotesOf } from '#shared/race-core.ts';
import { clock } from '#shared/clock.ts';
import { sendControlRequest } from '../control-ws.ts';
import './arena-panel.css';
import { el } from '../dom-helpers.ts';
import { emptyState } from '../ui/empty-state.ts';
import { isPhoneLayout } from '../form-factor.ts';
import { sessionUIs } from '../session-card/card-registry.ts';
import { onSessionTick } from '../session-card/session-tick.ts';
import { button } from '../ui/button.ts';
import { buildDialogShell, openConfirmDialog } from '../session-card/modal.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { buildNewRace } from './new-race-form.ts';
import type { RaceCard } from './race-card.ts';
import { createRaceCard } from './race-card.ts';
import type { LiveContestant } from './race-view-core.ts';
import { durationText, raceStage, unsettledCount } from './race-view-core.ts';
import { openRaceSession, raceHistory, raceList, subscribeRaces } from './race-store.ts';

const START_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 60_000;
const NO_VALUE = '-';

type ArenaTab = 'races' | 'new' | 'standings';

let root: HTMLElement | null = null;
let activeTab: ArenaTab = 'races';
const tabButtons = new Map<ArenaTab, HTMLButtonElement>();
const tabPanels = new Map<ArenaTab, HTMLElement>();
let liveCountEl: HTMLElement | null = null;
let racesEl: HTMLElement | null = null;
let racesEmptyEl: HTMLElement | null = null;
let historyEl: HTMLElement | null = null;
const cardByRaceId = new Map<string, RaceCard>();
const pastCardByRaceId = new Map<string, RaceCard>();

function liveOfSession(sessionId: string | undefined): LiveContestant | null {
  const ui = sessionId ? sessionUIs.get(sessionId) : undefined;
  if (!ui) return null;
  return { state: ui.currentState, stateSince: ui.stateSince, taskTitle: ui.taskTitle, isMonitoring: ui.awaitingBackgroundTasks === true };
}

function contestantState(sessionId: string | undefined): string {
  return sessionId && sessionUIs.has(sessionId) ? 'live' : REMOVED_CONTESTANT;
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function percentText(rate: number | null): string {
  return rate === null ? NO_VALUE : `${Math.round(rate * 100)}%`;
}

function seriesText(race: RaceRecord): string | null {
  if (!race.series) return null;
  const rounds = raceList().filter((candidate) => seriesKey(candidate) === seriesKey(race));
  const latestRound = Math.max(...rounds.map((round) => round.series?.round ?? 1));
  if (race.series.round !== latestRound) return null;
  const labelById = new Map(race.spec.contestants.map((contestant) => [contestant.id, contestant.label]));
  const scoreText = (score: number | null) => (race.spec.reviewCase ? `recall ${percentText(score)}` : String(score));
  const parts = seriesStanding(rounds).map((standing) => {
    const spread = standing.lowestScore === null ? 'no scores' : `scores ${scoreText(standing.lowestScore)} to ${scoreText(standing.highestScore)}`;
    return `${labelById.get(standing.contestantId) ?? standing.contestantId} ${standing.wins} of ${standing.roundsJudged} (${spread})`;
  });
  return `Series wins: ${parts.join(', ')}.`;
}

function setRaceStatus(race: RaceRecord, text: string): void {
  cardByRaceId.get(race.id)?.setStatus(text);
}

function openPickWinnerDialog(race: RaceRecord, winner: RaceContestant): void {
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title: `Pick ${winner.label} as the winner` });
  const losers = race.spec.contestants.filter((contestant) => contestant.id !== winner.id && contestantState(race.sessionIdByContestant[contestant.id]) !== REMOVED_CONTESTANT);
  const loserText = losers.length > 0
    ? `${losers.map((contestant) => contestant.label).join(', ')} will be stopped and removed with their worktrees and branches, without pushing. ${winner.label} stays an ordinary session.`
    : `${winner.label} stays an ordinary session. No other contestant is left to remove.`;
  dialog.append(el('p', 'dialog-message', loserText));
  const notes = winnerNotesOf(race, winner.id);
  const notesBox = el('input');
  notesBox.type = 'checkbox';
  if (notes) {
    const notesField = el('label', 'dialog-checkbox-label');
    notesField.append(notesBox, el('span', null, "Also send it the judges' notes"));
    dialog.append(notesField, el('pre', 'arena-raw-diff', notes));
  }
  const confirm = button({ variant: 'danger', label: 'Pick winner', onClick: () => {
    close();
    pickWinner(race, winner, notes !== null && notesBox.checked);
  } });
  actions.append(confirm);
  dialog.append(actions);
  btnCancel.addEventListener('click', close);
}

function pickWinner(race: RaceRecord, winner: RaceContestant, sendNotes: boolean): void {
  setRaceStatus(race, `Picking ${winner.label}.`);
  sendControlRequest('race-pick-winner', { raceId: race.id, contestantId: winner.id, sendNotes }, { timeoutMs: START_TIMEOUT_MS })
    .then((reply) => {
      if (reply.type !== 'race-pick-winner-result') return;
      setRaceStatus(race, reply.ok ? '' : `Picked ${winner.label} with problems: ${reply.error ?? 'unknown error'}`);
    })
    .catch((reason: unknown) => setRaceStatus(race, `Could not pick the winner: ${errorText(reason)}`));
}

function sendJudge(race: RaceRecord): void {
  setRaceStatus(race, 'Asking the judges.');
  sendControlRequest('race-judge', { raceId: race.id }, { timeoutMs: REQUEST_TIMEOUT_MS })
    .then((reply) => {
      if (reply.type !== 'race-judge-result') return;
      setRaceStatus(race, reply.ok ? '' : `Could not judge: ${reply.error ?? 'unknown error'}`);
    })
    .catch((reason: unknown) => setRaceStatus(race, `Could not judge: ${errorText(reason)}`));
}

function judgeRace(race: RaceRecord): void {
  const unsettled = unsettledCount(race, (contestantId) => liveOfSession(race.sessionIdByContestant[contestantId]));
  if (raceStage(race) !== 'running' || unsettled === 0) {
    sendJudge(race);
    return;
  }
  openConfirmDialog({
    title: 'Judge now',
    message: `${unsettled === 1 ? '1 contestant is' : `${unsettled} contestants are`} still working. Judging now reads each change as it stands, unfinished ones included, and those sessions keep running.`,
    confirmLabel: 'Judge now',
    onConfirm: () => sendJudge(race),
  });
}

const cardDeps = {
  liveOfSession,
  seriesText,
  openSession: openRaceSession,
  pickWinner: openPickWinnerDialog,
  judge: judgeRace,
};

function renderRaces(): void {
  if (!racesEl || !racesEmptyEl) return;
  const races = raceList();
  const liveIds = new Set(races.map((race) => race.id));
  for (const [raceId, card] of cardByRaceId) {
    if (liveIds.has(raceId)) continue;
    card.destroy();
    cardByRaceId.delete(raceId);
  }
  const ordered = races.map((race) => {
    const existing = cardByRaceId.get(race.id);
    if (existing) {
      existing.update(race);
      return existing.element;
    }
    const card = createRaceCard(race, { ...cardDeps, isPast: false });
    cardByRaceId.set(race.id, card);
    return card.element;
  });
  const isInOrder = ordered.length === racesEl.children.length && ordered.every((element, index) => racesEl?.children[index] === element);
  if (!isInOrder) racesEl.replaceChildren(...ordered);
  racesEmptyEl.hidden = races.length > 0;
  const running = races.filter((race) => raceStage(race) === 'running' || raceStage(race) === 'judging').length;
  if (liveCountEl) {
    liveCountEl.textContent = running === 0 ? '' : `${running} live`;
    liveCountEl.hidden = running === 0;
  }
}

function paintRaces(): void {
  if (activeTab !== 'races') return;
  const nowMs = clock.nowMs();
  for (const card of cardByRaceId.values()) card.paint(nowMs);
}

function tableOf(headings: readonly string[], rows: readonly (readonly string[])[]): HTMLElement {
  const wrap = el('div', 'arena-table-wrap');
  const table = el('table', 'arena-table');
  const headRow = el('tr');
  for (const heading of headings) headRow.append(el('th', null, heading));
  const head = el('thead');
  head.append(headRow);
  const body = el('tbody');
  for (const cells of rows) {
    const row = el('tr');
    for (const cell of cells) row.append(el('td', null, cell));
    body.append(row);
  }
  table.append(head, body);
  wrap.append(table);
  return wrap;
}

function standingCells(row: StandingRow): string[] {
  return [
    row.label, String(row.races), String(row.wins), percentText(row.wins / row.races),
    percentText(row.meanRecall),
    ...RACE_CRITERIA.map((criterion) => percentText(row.passRate[criterion])),
    row.meanCostUSD === null ? NO_VALUE : `$${row.meanCostUSD.toFixed(2)}`,
    row.meanElapsedMs === null ? NO_VALUE : durationText(row.meanElapsedMs),
  ];
}

function judgeCells(row: JudgeRow): string[] {
  return [row.label, `${row.matched} of ${row.races}`];
}

function buildPastRace(race: RaceRecord): HTMLElement {
  const item = el('li', 'arena-past-race');
  const winner = race.spec.contestants.find((contestant) => contestant.id === race.winnerContestantId);
  const summary = el('div', 'arena-past-summary');
  const toggle = button({ variant: 'quiet', size: 'small', label: 'Show', onClick: () => {
    const existing = pastCardByRaceId.get(race.id);
    if (existing) {
      existing.destroy();
      pastCardByRaceId.delete(race.id);
      toggle.setAttribute('aria-expanded', 'false');
      return;
    }
    const card = createRaceCard(race, { ...cardDeps, isPast: true });
    pastCardByRaceId.set(race.id, card);
    item.append(card.element);
    toggle.setAttribute('aria-expanded', 'true');
  } });
  toggle.setAttribute('aria-expanded', String(pastCardByRaceId.has(race.id)));
  summary.append(
    el('span', 'arena-past-title', race.spec.title),
    el('span', 'arena-status', `${clock.format(race.createdAt, 'date')}, ${race.spec.contestants.length} contestants${winner ? `, winner ${winner.label}` : ''}`),
    toggle,
  );
  item.append(summary);
  const shown = pastCardByRaceId.get(race.id);
  if (shown) {
    shown.update(race);
    item.append(shown.element);
  }
  return item;
}

function buildHistory(history: RaceHistory): HTMLElement[] {
  const parts: HTMLElement[] = [el('h2', 'arena-section-title', `Standings, ${history.judgedRaces} judged ${history.judgedRaces === 1 ? 'race' : 'races'}`)];
  if (history.standings.length === 0) {
    parts.push(emptyState({ text: 'No judged races yet. A race shows here once its judges rank it.' }));
    return parts;
  }
  parts.push(el('p', 'arena-status', 'One row per setup: agent, model, effort, home and instructions. A split criterion counts half.'));
  parts.push(tableOf(['Setup', 'Races', 'Wins', 'Win rate', 'Recall', 'Correct', 'Complete', 'Scope', 'Quality', 'Cost', 'Time'], history.standings.map(standingCells)));
  if (history.judges.length > 0) {
    parts.push(el('h3', 'arena-label arena-history-heading', 'Judges'));
    parts.push(tableOf(['Judge', 'Ranked your pick first'], history.judges.map(judgeCells)));
  }
  if (history.past.length > 0) {
    parts.push(el('h3', 'arena-label arena-history-heading', `Past races, latest ${history.past.length}`));
    const list = el('ul', 'arena-past-races');
    for (const race of history.past) list.append(buildPastRace(race));
    parts.push(list);
  }
  return parts;
}

function renderHistory(): void {
  if (!historyEl) return;
  const history = raceHistory();
  const pastIds = new Set(history?.past.map((race) => race.id) ?? []);
  for (const [raceId, card] of pastCardByRaceId) {
    if (pastIds.has(raceId)) continue;
    card.destroy();
    pastCardByRaceId.delete(raceId);
  }
  historyEl.replaceChildren(...(history ? buildHistory(history) : [el('p', 'arena-empty', 'Loading the standings.')]));
}

function selectTab(tab: ArenaTab): void {
  activeTab = tab;
  for (const [key, tabButton] of tabButtons) tabButton.setAttribute('aria-pressed', String(key === tab));
  for (const [key, panel] of tabPanels) panel.hidden = key !== tab;
  if (tab === 'races') paintRaces();
}

function buildSubnav(): HTMLElement {
  const nav = el('nav', 'arena-subnav');
  nav.setAttribute('aria-label', 'Arena');
  const tabs: { key: ArenaTab; label: string }[] = [{ key: 'races', label: 'Races' }, { key: 'new', label: 'New race' }, { key: 'standings', label: 'Standings' }];
  for (const tab of tabs) {
    if (tab.key === 'new' && isPhoneLayout()) continue;
    const tabButton = button({ variant: 'secondary', size: 'small', label: tab.label, onClick: () => selectTab(tab.key) });
    tabButtons.set(tab.key, tabButton);
    nav.append(tabButton);
    if (tab.key === 'races') {
      liveCountEl = el('span', 'arena-live-count');
      liveCountEl.hidden = true;
      nav.append(liveCountEl);
    }
  }
  return nav;
}

function mountArenaView(parent: HTMLElement): void {
  if (root) return;
  root = el('div', 'arena-content');
  const racesPanel = el('section', 'arena-tab-panel');
  racesEl = el('div', 'arena-races');
  racesEmptyEl = emptyState({ text: isPhoneLayout()
    ? 'No races yet. Start one from New race on the desktop dashboard, or have an agent run glimmervoid arena start.'
    : 'No races yet. Start one from New race, or have an agent run glimmervoid arena start.' });
  racesPanel.append(racesEmptyEl, racesEl);
  tabPanels.set('races', racesPanel);
  if (!isPhoneLayout()) tabPanels.set('new', buildNewRace(() => selectTab('races')));
  historyEl = el('section', 'arena-tab-panel arena-history');
  tabPanels.set('standings', historyEl);
  root.append(buildSubnav(), ...tabPanels.values());
  parent.append(root);
  subscribeRaces(renderRaces);
  subscribeRaces(renderHistory);
  onSessionTick(paintRaces);
  renderRaces();
  renderHistory();
  selectTab(activeTab);
}

export const view: ViewModule<HTMLElement> = { mount: mountArenaView };
