import { DEFAULT_REPLY_TIMEOUT_MS, clearHeaderError, reportHeaderError, requestFailureText } from './action-status.ts';
import { sendControlRequest } from './control-ws.ts';
import { getJSON, setJSON } from './local-store.ts';

const STREAMER_MODE_STORAGE_KEY = 'glimmervoid-streamer-mode';
const streamerModeListeners = new Set<(isEnabled: boolean) => void>();
let isStreamerModeEnabled = getJSON<unknown>(STREAMER_MODE_STORAGE_KEY, false) === true;
let streamerToggleButton: HTMLButtonElement | null = null;

function applyStreamerAttribute(isEnabled: boolean) {
  document.documentElement.toggleAttribute('data-streamer', isEnabled);
  streamerToggleButton?.setAttribute('aria-pressed', String(isEnabled));
}

applyStreamerAttribute(isStreamerModeEnabled);

export function isStreamerMode() {
  return isStreamerModeEnabled;
}

export function setStreamerMode(isEnabled: boolean) {
  setJSON(STREAMER_MODE_STORAGE_KEY, isEnabled);
  if (isEnabled === isStreamerMode()) return;
  isStreamerModeEnabled = isEnabled;
  applyStreamerAttribute(isEnabled);
  for (const listener of streamerModeListeners) listener(isEnabled);
}

export function onStreamerModeChanged(listener: (isEnabled: boolean) => void) {
  streamerModeListeners.add(listener);
  return () => streamerModeListeners.delete(listener);
}

export async function saveStreamerMode(isEnabled: boolean): Promise<string> {
  try {
    const message = await sendControlRequest('update-settings', { settings: { streamerMode: isEnabled } }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
    if (message.type === 'settings-error') return String(message.message);
    setStreamerMode(isEnabled);
    return '';
  } catch (error) {
    return requestFailureText(error, DEFAULT_REPLY_TIMEOUT_MS);
  }
}

const STREAMER_ERROR_SOURCE = 'Streamer mode';

async function toggleAndPersistStreamerMode() {
  const shouldEnable = !isStreamerMode();
  if (shouldEnable) setStreamerMode(true);
  const saveError = await saveStreamerMode(shouldEnable);
  if (!saveError) {
    clearHeaderError(STREAMER_ERROR_SOURCE);
    return;
  }
  const outcome = shouldEnable ? 'Streamer mode is on in this browser only. The server did not save it' : 'Streamer mode is still on. The server did not save the change';
  reportHeaderError({ source: STREAMER_ERROR_SOURCE, message: `${outcome}: ${saveError} Toggle it again to retry.`, hidesInStreamerMode: false });
}

export function toggleStreamerMode() {
  void toggleAndPersistStreamerMode();
}

export function mountStreamerToggle(button: HTMLButtonElement) {
  streamerToggleButton = button;
  applyStreamerAttribute(isStreamerMode());
  button.addEventListener('click', toggleStreamerMode);
}
