import type { RaceContestant, RaceRecord } from '#shared/contracts/race.ts';
import { winnerNotesOf } from '#shared/race-core.ts';
import { clock } from '#shared/clock.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { mountPatchDiff } from '../review/diff-view.ts';
import type { MountedFileDiff } from '../review/diff-view.ts';
import { paintStatusIcon } from '../status-icon.ts';
import { button } from '../ui/button.ts';
import type { RowActions, LiveContestant, ScoreArea } from './race-view-core.ts';
import {
  costCell, diffCell, footHint, hasCheckColumn, rowActions, rowDoing, rowStatus, rowTimeText, rowTrack, orderedContestants, raceClock, raceMeta, raceStage, rankText, scoreArea,
  scoreHeadings, setupCaption, splitUnifiedDiff, stepsOf, trackAxisMs,
} from './race-view-core.ts';

const DIFF_TIMEOUT_MS = 60_000;
const MAX_DIFF_FILES = 40;

interface RaceCardDeps {
  isPast: boolean;
  liveOfSession: (sessionId: string | undefined) => LiveContestant | null;
  seriesText: (race: RaceRecord) => string | null;
  openSession: (sessionId: string) => void;
  pickWinner: (race: RaceRecord, contestant: RaceContestant) => void;
  judge: (race: RaceRecord) => void;
}

export interface RaceCard {
  element: HTMLElement;
  update: (race: RaceRecord) => void;
  paint: (nowMs: number) => void;
  setStatus: (text: string) => void;
  destroy: () => void;
}

interface CellRefs {
  value: HTMLElement;
  caption: HTMLElement;
}

interface RowRefs {
  root: HTMLLIElement;
  rank: HTMLElement;
  icon: HTMLElement;
  name: HTMLElement;
  setup: HTMLElement;
  tag: HTMLElement;
  doing: HTMLElement;
  score: HTMLElement;
  scoreKey: string;
  trackFill: HTMLElement | null;
  trackFlag: HTMLElement | null;
  diff: CellRefs;
  time: CellRefs;
  cost: CellRefs;
  actions: HTMLElement;
  actionsKey: string;
  detailsButton: HTMLButtonElement | null;
  drawer: Drawer;
}

interface Drawer {
  root: HTMLElement;
  notes: HTMLElement;
  check: HTMLElement;
  diffSection: HTMLElement;
  diffAsOf: HTMLElement;
  diffFiles: HTMLElement;
  mounted: MountedFileDiff[];
  hasLoadedDiff: boolean;
  notesKey: string;
  checkKey: string;
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

function setData(element: HTMLElement, key: string, value: string): void {
  if (element.dataset[key] !== value) element.dataset[key] = value;
}

function buildCell(className: string): { root: HTMLElement; refs: CellRefs } {
  const root = el('div', `arena-cell ${className}`);
  const value = el('span', 'arena-cell-value');
  const caption = el('span', 'arena-cell-caption');
  root.append(value, caption);
  return { root, refs: { value, caption } };
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function scoreKeyOf(area: ScoreArea): string {
  if (area.kind === 'criteria') return `criteria:${area.cells.map((cell) => `${cell.key}=${cell.standing}`).join(',')}`;
  if (area.kind === 'recall') return `recall:${area.text}`;
  if (area.kind === 'note') return `note:${area.text}`;
  return 'track';
}

function criterionMark(label: string, standing: string): HTMLElement {
  const cell = el('span', 'arena-criterion');
  cell.dataset.standing = standing;
  cell.setAttribute('role', 'img');
  cell.setAttribute('aria-label', `${label} ${standing}`);
  cell.append(el('span', 'arena-criterion-name', label));
  if (standing === 'split' || standing === 'none') {
    cell.append(el('span', null, standing === 'split' ? 'split' : '-'));
    return cell;
  }
  const icon = el('span', 'arena-criterion-icon');
  paintStatusIcon(icon, standing === 'pass' ? 'complete' : 'failed');
  cell.append(icon);
  return cell;
}

export function createRaceCard(initial: RaceRecord, deps: RaceCardDeps): RaceCard {
  let race = initial;
  let statusText = '';
  let lastNowMs = clock.nowMs();
  const rowById = new Map<string, RowRefs>();
  const liveOf = (contestantId: string): LiveContestant | null => (deps.isPast ? null : deps.liveOfSession(race.sessionIdByContestant[contestantId]));

  const element = el('article', 'arena-race');
  const head = el('header', 'arena-race-head');
  const heading = el('div', 'arena-race-heading');
  const titleEl = el('h3', 'arena-race-title');
  const metaEl = el('p', 'arena-race-meta');
  heading.append(titleEl, metaEl);
  const clockEl = el('div', 'arena-race-clock');
  const clockValue = el('span', 'arena-race-clock-value');
  const clockCaption = el('span', 'arena-race-clock-caption');
  clockEl.append(clockValue, clockCaption);
  const steps = el('ol', 'arena-steps');
  steps.setAttribute('aria-label', 'Race phase');
  const stepEls = Array.from({ length: 4 }, () => {
    const step = el('li', 'arena-step');
    steps.append(step);
    return step;
  });
  const limit = el('div', 'arena-limit');
  const limitFill = el('span', 'arena-limit-fill');
  limit.append(limitFill);
  head.append(heading, clockEl, steps, limit);
  const notice = el('p', 'arena-race-notice');
  notice.setAttribute('role', 'status');
  const rows = el('ol', 'arena-rows');
  const rowHead = el('li', 'arena-row arena-row-head');
  rowHead.setAttribute('aria-hidden', 'true');
  let rowHeadKey = '';
  rows.append(rowHead);
  const foot = el('footer', 'arena-race-foot');
  const footHintEl = el('span', 'arena-race-foot-hint');
  const footActions = el('div', 'arena-race-foot-actions');
  let footKey = '';
  foot.append(footHintEl, footActions);
  element.append(head, notice, rows, foot);

  function buildDrawer(contestantId: string): Drawer {
    const root = el('div', 'arena-drawer');
    root.hidden = true;
    const notes = el('section', 'arena-drawer-section');
    const check = el('section', 'arena-drawer-section');
    const diffSection = el('section', 'arena-drawer-section');
    const diffHead = el('div', 'arena-drawer-head');
    const diffAsOf = el('span', 'arena-drawer-meta');
    const diffFiles = el('div', 'arena-diff-files');
    const drawer: Drawer = { root, notes, check, diffSection, diffAsOf, diffFiles, mounted: [], hasLoadedDiff: false, notesKey: '', checkKey: '' };
    const openButton = button({ variant: 'secondary', size: 'small', label: 'Open session', onClick: () => {
      const sessionId = race.sessionIdByContestant[contestantId];
      if (sessionId) deps.openSession(sessionId);
    } });
    diffHead.append(el('span', 'arena-label', 'Diff'), diffAsOf, button({ variant: 'quiet', size: 'small', label: 'Reload', onClick: () => loadDiff(contestantId, drawer) }), openButton);
    diffSection.append(diffHead, diffFiles);
    root.append(notes, check, diffSection);
    return drawer;
  }

  function clearDiff(drawer: Drawer): void {
    for (const mounted of drawer.mounted) mounted.destroy();
    drawer.mounted = [];
  }

  function showDiff(drawer: Drawer, text: string): void {
    clearDiff(drawer);
    const files = splitUnifiedDiff(text);
    if (files.length === 0) {
      drawer.diffFiles.replaceChildren(el('p', 'arena-empty', text.trim() === '' ? 'No changes yet.' : text));
      return;
    }
    drawer.diffFiles.replaceChildren();
    for (const file of files.slice(0, MAX_DIFF_FILES)) {
      const fileEl = el('div', 'arena-diff-file');
      const fileHead = el('div', 'arena-diff-file-head');
      const counts = el('span', 'arena-diff-file-counts');
      counts.append(el('span', 'arena-added', `+${file.added}`), el('span', 'arena-removed', `-${file.removed}`));
      fileHead.append(el('span', 'arena-diff-file-path', file.path), counts);
      const host = el('div', 'review-diff-body arena-diff-body');
      fileEl.append(fileHead, host);
      drawer.diffFiles.append(fileEl);
      mountPatchDiff(host, file.patch, 'unified')
        .then((mounted) => { drawer.mounted.push(mounted); })
        .catch((reason: unknown) => host.replaceChildren(el('pre', 'arena-raw-diff', file.patch), el('p', 'arena-error', `Could not draw this diff: ${errorText(reason)}`)));
    }
    if (files.length > MAX_DIFF_FILES) drawer.diffFiles.append(el('p', 'arena-empty', `${files.length - MAX_DIFF_FILES} more files are not shown. Open the session to read them in Changes.`));
  }

  function loadDiff(contestantId: string, drawer: Drawer): void {
    drawer.hasLoadedDiff = true;
    setText(drawer.diffAsOf, 'Loading the diff.');
    sendControlRequest('race-diff', { raceId: race.id, contestantId }, { timeoutMs: DIFF_TIMEOUT_MS })
      .then((reply) => {
        if (reply.type !== 'race-diff-result') return;
        if (!reply.ok) {
          setText(drawer.diffAsOf, `Could not read the diff: ${reply.error ?? 'unknown error'}`);
          return;
        }
        setText(drawer.diffAsOf, `as of ${clock.format(clock.nowMs(), 'hour-minute-second')}`);
        showDiff(drawer, reply.diff ?? '');
      })
      .catch((reason: unknown) => setText(drawer.diffAsOf, `Could not read the diff: ${errorText(reason)}`));
  }

  function toggleDrawer(contestant: RaceContestant): void {
    const row = rowById.get(contestant.id);
    if (!row) return;
    const drawer = row.drawer;
    drawer.root.hidden = !drawer.root.hidden;
    row.detailsButton?.setAttribute('aria-expanded', String(!drawer.root.hidden));
    if (!drawer.root.hidden && !drawer.hasLoadedDiff && liveOf(contestant.id) !== null) loadDiff(contestant.id, drawer);
    paintRow(contestant, lastNowMs, trackAxisMs(race, liveOf, lastNowMs));
  }

  function buildRow(contestant: RaceContestant): RowRefs {
    const root = el('li', 'arena-row');
    root.dataset.contestant = contestant.id;
    const rank = el('span', 'arena-row-rank');
    const icon = el('span', 'arena-row-icon');
    const who = el('div', 'arena-row-who');
    const nameLine = el('div', 'arena-row-name-line');
    const name = el('span', 'arena-row-name');
    const setup = el('span', 'arena-row-setup');
    const tag = el('span', 'arena-row-tag');
    nameLine.append(name, setup, tag);
    const doing = el('span', 'arena-row-doing');
    who.append(nameLine, doing);
    const score = el('div', 'arena-row-score');
    const diff = buildCell('arena-cell-diff');
    const time = buildCell('arena-cell-time');
    const cost = buildCell('arena-cell-cost');
    const actions = el('div', 'arena-row-actions');
    const drawer = buildDrawer(contestant.id);
    root.append(rank, icon, who, score, diff.root, time.root, cost.root, actions, drawer.root);
    return { root, rank, icon, name, setup, tag, doing, score, scoreKey: '', trackFill: null, trackFlag: null, diff: diff.refs, time: time.refs, cost: cost.refs, actions, actionsKey: '', detailsButton: null, drawer };
  }

  function paintScore(row: RowRefs, area: ScoreArea, contestantId: string, nowMs: number, axisMs: number): void {
    const key = scoreKeyOf(area);
    if (row.scoreKey !== key) {
      row.scoreKey = key;
      row.trackFill = null;
      row.trackFlag = null;
      setData(row.score, 'kind', area.kind);
      if (area.kind === 'track') {
        const rail = el('span', 'arena-track');
        row.trackFill = el('span', 'arena-track-fill');
        row.trackFlag = el('span', 'arena-track-flag');
        rail.append(row.trackFill, row.trackFlag);
        row.score.replaceChildren(rail);
      }
      if (area.kind === 'criteria') row.score.replaceChildren(...area.cells.map((cell) => criterionMark(cell.label, cell.standing)));
      if (area.kind === 'recall') {
        const bar = el('span', 'arena-track');
        const fill = el('span', 'arena-track-fill');
        fill.style.transform = `scaleX(${area.fraction})`;
        bar.append(fill);
        row.score.replaceChildren(bar, el('span', 'arena-score-text', area.text));
      }
      if (area.kind === 'note') row.score.replaceChildren(el('span', 'arena-score-text', area.text));
    }
    if (area.kind !== 'track' || !row.trackFill || !row.trackFlag) return;
    const track = rowTrack(race, contestantId, liveOf(contestantId), nowMs, axisMs);
    const transform = `scaleX(${track.fraction.toFixed(4)})`;
    if (row.trackFill.style.transform !== transform) row.trackFill.style.transform = transform;
    row.trackFlag.hidden = !track.isFinished;
    const flagTransform = `translateX(${(track.fraction * 100).toFixed(2)}cqw)`;
    if (row.trackFlag.style.transform !== flagTransform) row.trackFlag.style.transform = flagTransform;
  }

  function paintActions(row: RowRefs, contestant: RaceContestant, actions: RowActions): void {
    const key = `${actions.canOpen}|${actions.detailsLabel}|${actions.pick}`;
    if (row.actionsKey === key) return;
    row.actionsKey = key;
    row.detailsButton = null;
    const items: HTMLElement[] = [];
    const sessionId = race.sessionIdByContestant[contestant.id];
    if (actions.canOpen && sessionId) items.push(button({ variant: 'secondary', size: 'small', label: 'Open', onClick: () => deps.openSession(sessionId) }));
    if (actions.detailsLabel) {
      row.detailsButton = button({ variant: 'quiet', size: 'small', label: actions.detailsLabel, onClick: () => toggleDrawer(contestant) });
      row.detailsButton.setAttribute('aria-expanded', String(!row.drawer.root.hidden));
      items.push(row.detailsButton);
    }
    if (actions.pick) items.push(button({ variant: actions.pick, size: 'small', label: 'Pick winner', onClick: () => deps.pickWinner(race, contestant) }));
    row.actions.replaceChildren(...items);
  }

  function paintDrawer(row: RowRefs, contestant: RaceContestant): void {
    const drawer = row.drawer;
    if (drawer.root.hidden) return;
    const summary = race.panel?.standing.find((entry) => entry.contestantId === contestant.id)?.summary ?? '';
    const notes = [summary, winnerNotesOf(race, contestant.id) ?? ''].filter((part) => part.trim() !== '').join('\n\n');
    if (drawer.notesKey !== notes) {
      drawer.notesKey = notes;
      drawer.notes.hidden = notes === '';
      drawer.notes.replaceChildren(el('span', 'arena-label', 'Judges'), el('p', 'arena-notes', notes));
    }
    const check = race.checkByContestant[contestant.id];
    const checkKey = check ? `${check.status}:${check.outputTail.length}` : '';
    if (drawer.checkKey !== checkKey) {
      drawer.checkKey = checkKey;
      drawer.check.hidden = !check?.outputTail;
      drawer.check.replaceChildren(el('span', 'arena-label', 'Check output'), el('pre', 'arena-raw-diff', check?.outputTail ?? ''));
    }
    drawer.diffSection.hidden = liveOf(contestant.id) === null;
  }

  function paintRow(contestant: RaceContestant, nowMs: number, axisMs: number): void {
    const row = rowById.get(contestant.id);
    if (!row) return;
    const live = liveOf(contestant.id);
    const status = rowStatus(race, contestant.id, live, deps.isPast);
    setData(row.root, 'state', status.stateKey);
    row.root.toggleAttribute('data-winner', race.winnerContestantId === contestant.id);
    paintStatusIcon(row.icon, status.icon);
    setText(row.rank, rankText(race, contestant.id));
    setText(row.name, contestant.label);
    setText(row.setup, setupCaption(contestant));
    setText(row.tag, race.winnerContestantId === contestant.id ? 'Winner' : '');
    setText(row.doing, rowDoing(race, contestant.id, live, nowMs));
    paintScore(row, scoreArea(race, contestant.id), contestant.id, nowMs, axisMs);
    const diff = diffCell(race.diffStatsByContestant[contestant.id], race.checkByContestant[contestant.id], hasCheckColumn(race));
    setText(row.diff.value, diff.value);
    setText(row.diff.caption, diff.caption);
    setText(row.time.value, rowTimeText(race, contestant.id, live, nowMs));
    setText(row.time.caption, status.label);
    const cost = costCell(race.metricsByContestant[contestant.id]);
    const hidesCost = !race.metricsByContestant[contestant.id];
    setText(row.cost.value, hidesCost ? '' : cost.value);
    setText(row.cost.caption, hidesCost ? '' : cost.caption);
    paintActions(row, contestant, rowActions(race, contestant.id, live, deps.isPast));
    paintDrawer(row, contestant);
  }

  function paintRowHead(): void {
    const headings = scoreHeadings(race);
    const hasCost = Object.keys(race.metricsByContestant).length > 0;
    const key = `${headings.join(',')}|${hasCost}`;
    setData(rows, 'score', headings.length > 1 ? 'criteria' : 'single');
    rows.style.setProperty('--arena-score-columns', String(headings.length));
    if (key === rowHeadKey) return;
    rowHeadKey = key;
    const score = el('div', 'arena-row-score');
    score.append(...headings.map((heading) => el('span', null, heading)));
    rowHead.replaceChildren(el('span'), el('span'), el('span', null, 'Contestant'), score, el('span', 'arena-cell', 'Diff'), el('span', 'arena-cell', 'Time'), el('span', 'arena-cell', hasCost ? 'Cost' : ''), el('span'));
  }

  function paintRows(nowMs: number): void {
    paintRowHead();
    const ordered = orderedContestants(race);
    const axisMs = trackAxisMs(race, liveOf, nowMs);
    for (const contestant of ordered) {
      if (!rowById.has(contestant.id)) rowById.set(contestant.id, buildRow(contestant));
      paintRow(contestant, nowMs, axisMs);
    }
    const wanted = [rowHead, ...ordered.map((contestant) => rowById.get(contestant.id)?.root).filter((root): root is HTMLLIElement => root !== undefined)];
    const isInOrder = wanted.length === rows.children.length && wanted.every((root, index) => rows.children[index] === root);
    if (!isInOrder) rows.replaceChildren(...wanted);
  }

  function paintFoot(): void {
    setText(footHintEl, deps.isPast ? '' : footHint(race, liveOf));
    const stage = raceStage(race);
    const key = deps.isPast ? 'past' : stage;
    if (footKey === key) return;
    footKey = key;
    const items: HTMLElement[] = [];
    if (!deps.isPast && stage === 'running') items.push(button({ variant: 'secondary', size: 'small', label: 'Judge now', onClick: () => deps.judge(race) }));
    if (!deps.isPast && stage === 'judged') items.push(button({ variant: 'quiet', size: 'small', label: 'Judge again', onClick: () => deps.judge(race) }));
    footActions.replaceChildren(...items);
  }

  function noticeText(): string {
    const failures = race.panel?.failures.map((failure) => `Judge ${failure.label} failed: ${failure.reason}`) ?? [];
    return [statusText, race.judgeError, ...failures, deps.seriesText(race)].filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
  }

  function paint(nowMs: number): void {
    lastNowMs = nowMs;
    const stage = raceStage(race);
    setData(element, 'stage', deps.isPast ? 'past' : stage);
    setText(titleEl, race.spec.title);
    setText(metaEl, raceMeta(race, (ms) => clock.format(ms, 'date-time')));
    const raceClockNow = raceClock(race, liveOf, nowMs);
    setText(clockValue, raceClockNow.value);
    setText(clockCaption, raceClockNow.caption);
    stepsOf(race, liveOf).forEach((step, index) => {
      const stepEl = stepEls[index];
      if (!stepEl) return;
      setText(stepEl, step.label);
      setData(stepEl, 'status', step.status);
      if (step.status === 'now') stepEl.setAttribute('aria-current', 'step');
      if (step.status !== 'now') stepEl.removeAttribute('aria-current');
    });
    limit.hidden = raceClockNow.limitFraction === null;
    if (raceClockNow.limitFraction !== null) {
      const transform = `scaleX(${raceClockNow.limitFraction.toFixed(4)})`;
      if (limitFill.style.transform !== transform) limitFill.style.transform = transform;
    }
    const noticeNow = noticeText();
    setText(notice, noticeNow);
    notice.hidden = noticeNow === '';
    paintRows(nowMs);
    paintFoot();
  }

  paint(lastNowMs);

  return {
    element,
    update: (next) => {
      race = next;
      paint(clock.nowMs());
    },
    paint,
    setStatus: (text) => {
      statusText = text;
      paint(clock.nowMs());
    },
    destroy: () => {
      for (const row of rowById.values()) clearDiff(row.drawer);
      element.remove();
    },
  };
}
