import { el } from '../dom-helpers.ts';
import type { MobileKey } from '../mobile-keys.ts';
import { arrowStepsForDrag, isClipboardKey, isUploadKey, mobileKeyBytes, MOBILE_KEYS } from '../mobile-keys.ts';
import { uploadFileToSession } from '../session-upload.ts';

const CONTROL_BYTES_BY_SYMBOL: Readonly<Record<string, string>> = {
  ' ': '\x00',
  '@': '\x00',
  '[': '\x1b',
  '\\': '\x1c',
  ']': '\x1d',
  '^': '\x1e',
  '_': '\x1f',
  '?': '\x7f',
};

export function controlBytesForCharacter(character: string): string | null {
  if (character.length !== 1) return null;
  const lowerCase = character.toLowerCase();
  if (lowerCase >= 'a' && lowerCase <= 'z') return String.fromCharCode(lowerCase.charCodeAt(0) - 96);
  return CONTROL_BYTES_BY_SYMBOL[character] ?? null;
}

interface MobileKeyStripOptions {
  send: (data: string | null | undefined) => void;
  getSessionId?: () => string | null | undefined;
  reportProblem: (text: string) => void;
}

export function createMobileKeyStrip({ send, getSessionId, reportProblem }: MobileKeyStripOptions) {
  const strip = el('div', 'phone-key-strip');
  strip.setAttribute('role', 'toolbar');
  strip.setAttribute('aria-label', 'Terminal keys');

  let filePicker: HTMLInputElement | null = null;
  let pickingButton: HTMLButtonElement | null = null;

  const controlButton = el('button', 'phone-key phone-key-ctrl', 'Ctrl');
  controlButton.type = 'button';
  controlButton.title = 'Hold Ctrl for the next key you type';
  controlButton.setAttribute('aria-pressed', 'false');
  controlButton.addEventListener('pointerdown', (event) => event.preventDefault());
  controlButton.addEventListener('click', () => setControlHeld(!isControlHeld()));
  strip.appendChild(controlButton);

  function isControlHeld() {
    return controlButton.getAttribute('aria-pressed') === 'true';
  }

  function setControlHeld(isHeld: boolean) {
    controlButton.setAttribute('aria-pressed', String(isHeld));
  }

  function takeHeldControl() {
    if (!isControlHeld()) return false;
    setControlHeld(false);
    return true;
  }

  for (const key of MOBILE_KEYS) {
    if (key.id === 'left') strip.appendChild(createArrowPad(send));
    const btn = el('button', key.isArrow ? 'phone-key phone-key-arrow' : 'phone-key', key.label);
    btn.type = 'button';
    btn.dataset.key = key.id;
    btn.title = key.title;
    if (key.isArrow) btn.setAttribute('aria-label', key.title);

    btn.addEventListener('pointerdown', (event) => event.preventDefault());
    btn.addEventListener('click', () => pressKey(key, btn));
    strip.appendChild(btn);
  }

  function pressKey(key: Readonly<MobileKey>, btn: HTMLButtonElement) {
    if (isUploadKey(key)) {
      openUploadPicker(btn);
      return;
    }
    if (isClipboardKey(key)) {
      pasteFromClipboard(send, reportProblem);
      return;
    }

    send(mobileKeyBytes(key.id));
  }

  function openUploadPicker(btn: HTMLButtonElement) {
    pickingButton = btn;
    if (!filePicker) {
      filePicker = el('input', 'phone-file-picker');
      filePicker.type = 'file';
      filePicker.hidden = true;
      filePicker.addEventListener('change', onFilePicked);
      strip.appendChild(filePicker);
    }
    filePicker.click();
  }

  function onFilePicked() {
    const picker = filePicker;
    if (!picker) return;
    const file = picker.files ? picker.files[0] : null;

    picker.value = '';
    if (!file) return;
    const sessionId = getSessionId?.();
    if (!sessionId) {
      reportProblem('No session is open to upload to.');
      return;
    }
    uploadPickedFile(sessionId, file, pickingButton);
  }

  async function uploadPickedFile(sessionId: string, file: File, btn: HTMLButtonElement | null) {
    if (btn) btn.disabled = true;
    await uploadFileToSession(sessionId, file);
    if (btn) btn.disabled = false;
  }

  return { element: strip, takeHeldControl };
}

function createArrowPad(send: (data: string | null | undefined) => void) {
  const pad = el('button', 'phone-key phone-arrow-pad', 'Arrows');
  pad.type = 'button';
  pad.title = 'Swipe to send arrow keys';
  let dragOrigin: { x: number; y: number } | null = null;
  let activePointerId: number | null = null;

  pad.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    if (activePointerId !== null) return;
    pad.setPointerCapture(event.pointerId);
    activePointerId = event.pointerId;
    dragOrigin = { x: event.clientX, y: event.clientY };
  });
  pad.addEventListener('pointermove', (event) => {
    if (event.pointerId !== activePointerId || !dragOrigin) return;
    const arrowSteps = arrowStepsForDrag(event.clientX - dragOrigin.x, event.clientY - dragOrigin.y);
    if (!arrowSteps) return;
    for (let step = 0; step < arrowSteps.stepCount; step++) send(mobileKeyBytes(arrowSteps.arrowKeyId));
    dragOrigin = { x: dragOrigin.x + arrowSteps.consumedX, y: dragOrigin.y + arrowSteps.consumedY };
  });
  const endDrag = (event: PointerEvent) => {
    if (event.pointerId !== activePointerId) return;
    activePointerId = null;
    dragOrigin = null;
  };
  pad.addEventListener('pointerup', endDrag);
  pad.addEventListener('pointercancel', endDrag);
  return pad;
}

const PASTE_PERMISSION_TEXT = 'Paste needs clipboard permission.';

function pasteFromClipboard(send: (data: string) => void, reportProblem: (text: string) => void) {
  let read: Promise<string> | null | undefined = null;
  try {
    read = navigator.clipboard?.readText?.();
  } catch {
    reportProblem(PASTE_PERMISSION_TEXT);
    return;
  }
  if (!read) {
    reportProblem('Paste is unavailable in this browser.');
    return;
  }
  read
    .then((text) => { if (text) send(text); })
    .catch(() => reportProblem(PASTE_PERMISSION_TEXT));
}
