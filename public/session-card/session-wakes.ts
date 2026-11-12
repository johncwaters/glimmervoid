import { clock, shiftDayKey } from '#shared/clock.ts';
import type { WakeView } from '#shared/contracts/wakes.ts';
import { el } from '../dom-helpers.ts';
import { sendForSession } from '../session-actions.ts';
import { createSignal } from '../signal.ts';
import { SIGNAL_TIER } from '../signal-core.ts';
import { button } from '../ui/button.ts';
import { buildDialogShell } from './modal.ts';
import { describeWakeTime } from './wake-time-core.ts';

const wakesBySessionId = new Map<string, readonly WakeView[]>();
let openWakeList: { sessionId: string; list: HTMLElement } | null = null;
let dayTurnTimer: ReturnType<typeof setTimeout> | null = null;
const DAY_TURN_SETTLE_MS = 1000;

const WAKE_TIME_FORMAT = {
  dayKeyOf: (moment: number) => clock.dayKeyOf(moment),
  shiftDayKey,
  hourMinuteOf: (moment: number) => clock.format(moment, 'hour-minute'),
  monthDayOf: (moment: number) => clock.format(moment, 'month-day'),
};

function wakeTimeText(wake: WakeView): string {
  return describeWakeTime(wake.nextFireAt, clock.nowMs(), WAKE_TIME_FORMAT);
}

function chipSlotsFor(sessionId: string): NodeListOf<HTMLElement> {
  return document.querySelectorAll<HTMLElement>(`[data-wake-chip-for="${CSS.escape(sessionId)}"]`);
}

export function hasPendingWakes(sessionId: string): boolean {
  return (wakesBySessionId.get(sessionId)?.length ?? 0) > 0;
}

export function paintWakeChip(slot: HTMLElement, sessionId: string): void {
  slot.dataset.wakeChipFor = sessionId;
  const nextWake = wakesBySessionId.get(sessionId)?.[0];
  slot.hidden = nextWake === undefined;
  if (!nextWake) {
    slot.replaceChildren();
    return;
  }
  const chip = createSignal(
    { key: 'wake', text: `wake ${wakeTimeText(nextWake)}`, look: null, tier: SIGNAL_TIER.settled },
    { className: 'session-wake-chip', ariaLabel: 'Show the wakes set for this session', onActivate: () => openSessionWakes(sessionId) },
  );
  slot.replaceChildren(chip);
}

function buildWakeRow(sessionId: string, wake: WakeView): HTMLElement {
  const row = el('li', 'session-wake-row');
  const details = el('span', 'session-wake-row-details');
  details.append(
    el('span', 'session-wake-row-time', wakeTimeText(wake)),
    el('span', 'session-wake-row-schedule', wake.kind === 'cron' ? `cron ${wake.pattern ?? ''}` : wake.id),
    el('span', 'session-wake-row-text', wake.text),
  );
  const btnCancelWake = button({ variant: 'quiet', size: 'small', label: 'Cancel wake' });
  btnCancelWake.setAttribute('aria-label', `Cancel wake ${wake.id}`);
  btnCancelWake.addEventListener('click', () => {
    btnCancelWake.disabled = true;
    if (!sendForSession(sessionId, { type: 'cancel-wake', id: sessionId, wake: wake.id })) btnCancelWake.disabled = false;
  });
  row.append(details, btnCancelWake);
  return row;
}

function paintWakeList(list: HTMLElement, sessionId: string): void {
  const sessionWakes = wakesBySessionId.get(sessionId) ?? [];
  if (sessionWakes.length === 0) {
    list.replaceChildren(el('li', 'session-wake-row-empty', 'No wakes are set for this session.'));
    return;
  }
  list.replaceChildren(...sessionWakes.map((wake) => buildWakeRow(sessionId, wake)));
}

export function openSessionWakes(sessionId: string): void {
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title: 'Wakes', cancelLabel: 'Close' });
  const hint = el('p', 'dialog-message', 'The session set these with glimmervoid wake. Each one is typed into the session when it comes due.');
  const list = el('ul', 'session-wake-rows');
  list.setAttribute('aria-label', 'Wakes set for this session');
  paintWakeList(list, sessionId);
  dialog.append(hint, list, actions);
  openWakeList = { sessionId, list };
  btnCancel.addEventListener('click', () => {
    openWakeList = null;
    close();
  });
}

function repaint(sessionId: string): void {
  for (const slot of chipSlotsFor(sessionId)) paintWakeChip(slot, sessionId);
  if (openWakeList?.sessionId === sessionId && openWakeList.list.isConnected) paintWakeList(openWakeList.list, sessionId);
}

function repaintAtNextDayTurn(): void {
  if (dayTurnTimer !== null) clearTimeout(dayTurnTimer);
  dayTurnTimer = null;
  if (![...wakesBySessionId.values()].some((sessionWakes) => sessionWakes.length > 0)) return;
  const nowMs = clock.nowMs();
  dayTurnTimer = setTimeout(() => {
    for (const sessionId of wakesBySessionId.keys()) repaint(sessionId);
    repaintAtNextDayTurn();
  }, clock.startOfDay(nowMs, -1) - nowMs + DAY_TURN_SETTLE_MS);
}

export function setSessionWakes(sessionId: string, sessionWakes: readonly WakeView[]): void {
  wakesBySessionId.set(sessionId, sessionWakes);
  repaint(sessionId);
  repaintAtNextDayTurn();
}

export function forgetSessionWakes(sessionId: string): void {
  wakesBySessionId.delete(sessionId);
  repaint(sessionId);
  repaintAtNextDayTurn();
}
