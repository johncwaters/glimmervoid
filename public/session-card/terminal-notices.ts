import type { Terminal } from '@xterm/xterm';
import { createActionStatus } from '../action-status.ts';
import type { ActionStatus, ActionStatusTone } from '../action-status.ts';
import type { SessionUi } from './card-registry.ts';
import { el, writeClipboardText } from '../dom-helpers.ts';

type TerminalNoticeKind = 'keys' | 'clipboard';

interface TerminalNotices {
  status: ActionStatus;
  shownKind: TerminalNoticeKind | null;
  clearTimerId: ReturnType<typeof setTimeout> | null;
  clipboardPrompt: HTMLElement;
  pendingClipboardText: string | null;
  jumpToLatestButton: HTMLButtonElement;
}

const terminalNoticesBySessionUi = new WeakMap<SessionUi, TerminalNotices>();

const OK_NOTICE_CLEAR_MS = 5000;

const ERROR_NOTICE_CLEAR_MS = 15000;

const CLIPBOARD_PROMPT_TEXT = 'The agent copied text. The browser needs a click before it can reach your clipboard.';

const CLIPBOARD_UNAVAILABLE_TEXT = 'The clipboard is unavailable in this browser.';

function showTerminalNotice(ui: SessionUi, kind: TerminalNoticeKind, tone: ActionStatusTone, text: string) {
  const notices = terminalNoticesBySessionUi.get(ui);
  if (!notices) return;
  if (notices.clearTimerId !== null) clearTimeout(notices.clearTimerId);
  notices.clearTimerId = null;
  notices.shownKind = kind;
  notices.status.show(tone, text);
  if (tone === 'busy') return;
  notices.clearTimerId = setTimeout(() => clearTerminalNotice(ui, kind), tone === 'ok' ? OK_NOTICE_CLEAR_MS : ERROR_NOTICE_CLEAR_MS);
}

function clearTerminalNotice(ui: SessionUi, kind: TerminalNoticeKind) {
  const notices = terminalNoticesBySessionUi.get(ui);
  if (!notices || notices.shownKind !== kind) return;
  if (notices.clearTimerId !== null) clearTimeout(notices.clearTimerId);
  notices.clearTimerId = null;
  notices.shownKind = null;
  notices.status.clear();
}

function isScrolledAwayFromLatest(term: Terminal) {
  const buffer = term.buffer.active;
  return buffer.viewportY < buffer.baseY;
}

function refreshJumpToLatest(ui: SessionUi, term: Terminal, { hasNewOutput = false }: { hasNewOutput?: boolean } = {}) {
  const button = terminalNoticesBySessionUi.get(ui)?.jumpToLatestButton;
  if (!button) return;
  const isScrolledAway = isScrolledAwayFromLatest(term);
  button.hidden = !isScrolledAway;
  if (!isScrolledAway) {
    delete button.dataset.hasNewOutput;
    return;
  }
  if (hasNewOutput) button.dataset.hasNewOutput = 'true';
}

function decodeOsc52Payload(b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function reportClipboardFailure(ui: SessionUi, source: string, err: unknown) {
  const msg = (err instanceof Error ? err.message : '') || String(err);
  console.error(`[clipboard:${source}]`, err);
  showTerminalNotice(ui, 'clipboard', 'error', `Clipboard ${source} failed: ${msg}`);
}

function copyTextToClipboard(ui: SessionUi, text: string, source: string, successText?: string) {
  const write = writeClipboardText(text);
  if (!write) {
    showTerminalNotice(ui, 'clipboard', 'error', CLIPBOARD_UNAVAILABLE_TEXT);
    return;
  }
  write
    .then(() => {
      if (successText) showTerminalNotice(ui, 'clipboard', 'ok', successText);
    })
    .catch((err) => reportClipboardFailure(ui, source, err));
}

function offerClipboardCopy(ui: SessionUi, text: string) {
  const notices = terminalNoticesBySessionUi.get(ui);
  if (!notices) return;
  notices.pendingClipboardText = text;
  notices.clipboardPrompt.hidden = false;
}

function copyOfferedClipboardText(ui: SessionUi) {
  const notices = terminalNoticesBySessionUi.get(ui);
  const text = notices?.pendingClipboardText;
  if (!notices || text == null) return;
  notices.pendingClipboardText = null;
  notices.clipboardPrompt.hidden = true;
  copyTextToClipboard(ui, text, 'osc52 write', 'Copied to the clipboard.');
}

function buildTerminalNotices(termWrap: HTMLElement, ui: SessionUi, term: Terminal) {
  const status = createActionStatus('terminal-notice');
  const clipboardPrompt = el('div', 'terminal-clipboard-prompt');
  clipboardPrompt.hidden = true;
  const copyButton = el('button', 'btn-dialog btn-dialog-confirm', 'Copy to clipboard');
  copyButton.type = 'button';
  copyButton.addEventListener('click', () => copyOfferedClipboardText(ui));
  clipboardPrompt.append(el('span', 'terminal-clipboard-prompt-text', CLIPBOARD_PROMPT_TEXT), copyButton);
  const noticeStack = el('div', 'terminal-notices');
  noticeStack.append(clipboardPrompt, status.element);

  const jumpToLatestButton = el('button', 'terminal-jump-latest btn-dialog btn-dialog-ghost', 'Jump to latest');
  jumpToLatestButton.type = 'button';
  jumpToLatestButton.hidden = true;
  jumpToLatestButton.addEventListener('click', () => {
    term.scrollToBottom();
    term.focus();
  });

  const dropZone = el('div', 'terminal-drop-zone');
  dropZone.setAttribute('aria-hidden', 'true');
  dropZone.append(el('span', 'terminal-drop-zone-label', 'Drop to upload to this session'));

  termWrap.append(noticeStack, jumpToLatestButton, dropZone);
  terminalNoticesBySessionUi.set(ui, { status, shownKind: null, clearTimerId: null, clipboardPrompt, pendingClipboardText: null, jumpToLatestButton });
}

export { buildTerminalNotices, clearTerminalNotice, copyTextToClipboard, decodeOsc52Payload, isScrolledAwayFromLatest, offerClipboardCopy, refreshJumpToLatest, reportClipboardFailure, showTerminalNotice };
