import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { sendControlMsg, sendControlRequest } from './control-ws.ts';
import { el } from './dom-helpers.ts';
import { NOT_CONNECTED_TEXT } from './updates-view-core.ts';

type ActionStatusTone = 'busy' | 'ok' | 'error';

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
  if (tone !== 'error' || text === NOT_CONNECTED_TEXT) return text;
  return document.documentElement.hasAttribute('data-streamer') ? STREAMER_HIDDEN_ERROR_TEXT : text;
}

export function createActionStatus(className = 'action-status'): ActionStatus {
  const element = el('p', className);
  element.setAttribute('role', 'status');
  element.hidden = true;
  const clear = () => {
    element.hidden = true;
    element.textContent = '';
    delete element.dataset.tone;
  };
  const show = (tone: ActionStatusTone, text: string) => {
    element.className = `${className} text-xs ${TONE_CLASS[tone]}`;
    element.dataset.tone = tone;
    element.textContent = streamerSafeText(tone, text);
    element.hidden = false;
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

function headerStatusParts() {
  const line = document.getElementById('header-status');
  const text = document.getElementById('header-status-text');
  const dismiss = document.getElementById('header-status-dismiss');
  if (!line || !text || !dismiss) return null;
  if (dismiss.dataset.wired === undefined) {
    dismiss.dataset.wired = '';
    dismiss.addEventListener('click', dismissHeaderStatus);
  }
  return { line, text };
}

export function reportUnsourcedError(message: string, { hidesInStreamerMode = true }: { hidesInStreamerMode?: boolean } = {}) {
  const parts = headerStatusParts();
  if (!parts) return;
  parts.text.textContent = hidesInStreamerMode ? streamerSafeText('error', message) : message;
  parts.line.hidden = false;
}

export function clearUnsourcedError(message: string) {
  const parts = headerStatusParts();
  if (!parts || parts.text.textContent !== message) return;
  dismissHeaderStatus();
}

function dismissHeaderStatus() {
  const parts = headerStatusParts();
  if (!parts) return;
  parts.line.hidden = true;
  parts.text.textContent = '';
}
