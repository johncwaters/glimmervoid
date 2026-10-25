import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { COMPACT_FLOORED_AGO, elapsedText } from '#shared/display-text.ts';
import type { StatusIcon } from '#shared/state-icons.ts';
import { sendControlMsg, sendControlRequest } from './control-ws.ts';
import { el } from './dom-helpers.ts';
import { paintStatusIcon } from './status-icon.ts';
import { NOT_CONNECTED_TEXT } from './updates-view-core.ts';

export type ActionStatusTone = 'busy' | 'ok' | 'error';

export interface ActionStatus {
  element: HTMLElement;
  show: (tone: ActionStatusTone, text: string) => void;
  clear: () => void;
}

const TONE_CLASS: Record<ActionStatusTone, string> = {
  busy: 'text-text-muted',
  ok: 'text-state-done',
  error: 'text-state-failed',
};

export const DEFAULT_REPLY_TIMEOUT_MS = 15000;

const STREAMER_HIDDEN_ERROR_TEXT = 'Something went wrong. Details are hidden in streamer mode.';

function streamerSafeText(tone: ActionStatusTone, text: string): string {
  if (tone !== 'error' || text.startsWith(NOT_CONNECTED_TEXT)) return text;
  return document.documentElement.hasAttribute('data-streamer') ? STREAMER_HIDDEN_ERROR_TEXT : text;
}

const ICON_BY_TONE: Record<ActionStatusTone, StatusIcon> = {
  busy: 'working',
  ok: 'complete',
  error: 'failed',
};

function actionStatusParts(element: HTMLElement): { iconElement: HTMLElement; textElement: HTMLElement } {
  const existingIcon = element.querySelector<HTMLElement>(':scope > .action-status-icon');
  const existingText = element.querySelector<HTMLElement>(':scope > .action-status-text');
  if (existingIcon && existingText && element.childNodes.length === 2) return { iconElement: existingIcon, textElement: existingText };
  const iconElement = el('span', 'action-status-icon');
  iconElement.setAttribute('aria-hidden', 'true');
  const textElement = el('span', 'action-status-text');
  element.replaceChildren(iconElement, textElement);
  return { iconElement, textElement };
}

export function clearActionStatus(element: HTMLElement): void {
  element.replaceChildren();
  delete element.dataset.tone;
}

export function paintActionStatus(element: HTMLElement, tone: ActionStatusTone | null, text: string): void {
  if (!text) {
    clearActionStatus(element);
    return;
  }
  if (!tone) {
    clearActionStatus(element);
    element.textContent = text;
    return;
  }
  element.dataset.tone = tone;
  const { iconElement, textElement } = actionStatusParts(element);
  paintStatusIcon(iconElement, ICON_BY_TONE[tone]);
  textElement.textContent = streamerSafeText(tone, text);
}

export function createActionStatus(className = 'action-status'): ActionStatus {
  const element = el('p', className);
  element.setAttribute('role', 'status');
  element.hidden = true;
  const clear = () => {
    element.hidden = true;
    clearActionStatus(element);
  };
  const show = (tone: ActionStatusTone, text: string) => {
    element.className = `${className} text-xs ${TONE_CLASS[tone]}`;
    paintActionStatus(element, tone, text);
    element.hidden = !text;
  };
  return { element, show, clear };
}

export function sendOrReport(message: Record<string, unknown>, status: ActionStatus): boolean {
  if (sendControlMsg(message)) return true;
  status.show('error', NOT_CONNECTED_TEXT);
  return false;
}

export function requestFailureText(reason: unknown, timeoutMs: number): string {
  const message = reason instanceof Error ? reason.message : '';
  if (message === 'Request timed out') return `The server did not answer within ${Math.round(timeoutMs / 1000)} s.`;
  return message || NOT_CONNECTED_TEXT;
}

export async function requestWithStatus(type: string, payload: Record<string, unknown>, status: ActionStatus, { busyText, timeoutMs = DEFAULT_REPLY_TIMEOUT_MS }: { busyText?: string; timeoutMs?: number } = {}): Promise<ServerMessage | null> {
  if (busyText) status.show('busy', busyText);
  try {
    const reply = await sendControlRequest(type, payload, { timeoutMs });
    status.clear();
    return reply;
  } catch (reason) {
    status.show('error', requestFailureText(reason, timeoutMs));
    return null;
  }
}

interface HeaderError {
  source: string;
  sessionId?: string;
  message: string;
  hidesInStreamerMode?: boolean;
}

interface ShownHeaderError {
  source: string;
  sessionId: string | null;
  raisedAt: number;
}

let shownHeaderError: ShownHeaderError | null = null;
const HEADER_ERROR_AGE_REPAINT_MS = 30_000;
let headerAgeTimer: number | null = null;

function headerStatusParts() {
  const line = document.getElementById('header-status');
  const text = document.getElementById('header-status-text');
  const age = document.getElementById('header-status-age');
  const dismiss = document.getElementById('header-status-dismiss');
  if (!line || !text || !age || !dismiss) return null;
  if (dismiss.dataset.wired === undefined) {
    dismiss.dataset.wired = '';
    dismiss.addEventListener('click', dismissHeaderStatus);
  }
  return { line, text, age };
}

function paintHeaderErrorAge() {
  const parts = headerStatusParts();
  if (!parts || !shownHeaderError) return;
  const ageText = elapsedText(Date.now() - shownHeaderError.raisedAt, { ...COMPACT_FLOORED_AGO, justNowBelowSeconds: 60 });
  if (parts.age.textContent !== ageText) parts.age.textContent = ageText;
}

export function reportHeaderError({ source, sessionId, message, hidesInStreamerMode = true }: HeaderError) {
  const parts = headerStatusParts();
  if (!parts) return;
  const shownMessage = hidesInStreamerMode ? streamerSafeText('error', message) : message;
  const sourceElement = el('strong', 'header-status-source', source);
  parts.text.replaceChildren(sourceElement, ` ${shownMessage}`);
  parts.text.title = `${source}: ${shownMessage}`;
  shownHeaderError = { source, sessionId: sessionId ?? null, raisedAt: Date.now() };
  paintHeaderErrorAge();
  headerAgeTimer ??= window.setInterval(paintHeaderErrorAge, HEADER_ERROR_AGE_REPAINT_MS);
  parts.line.hidden = false;
}

export function clearHeaderError(source: string, sessionId?: string) {
  if (shownHeaderError?.source !== source) return;
  if (sessionId !== undefined && shownHeaderError.sessionId !== sessionId) return;
  dismissHeaderStatus();
}

export function clearHeaderErrorsForSession(sessionId: string) {
  if (shownHeaderError?.sessionId !== sessionId) return;
  dismissHeaderStatus();
}

function dismissHeaderStatus() {
  shownHeaderError = null;
  if (headerAgeTimer !== null) window.clearInterval(headerAgeTimer);
  headerAgeTimer = null;
  const parts = headerStatusParts();
  if (!parts) return;
  parts.line.hidden = true;
  parts.text.replaceChildren();
  parts.text.title = '';
  parts.age.textContent = '';
}
