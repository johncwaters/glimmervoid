import type { OperatorActionOf } from '#shared/contracts/control-messages.ts';
import { createActionStatus, DEFAULT_REPLY_TIMEOUT_MS, requestFailureText } from '../action-status.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { el, externalLink } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { applySettingsBroadcast, settingsPayloadSnapshot } from '../settings/settings-store.ts';

const READ_TOKEN_PATH = 'github.readToken' as const;
const FINE_GRAINED_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new?name=Glimmervoid+lanes+read-only&description=Read-only+GitHub+access+for+Glimmervoid+Community%2C+Team+review+and+Radar+research&expires_in=90&contents=read&issues=read&pull_requests=read';
const TOKEN_SETTINGS = [
  { label: 'Permissions', value: 'Contents, Issues, Pull requests: Read-only', note: 'filled in' },
  { label: 'Expiration', value: '90 days', note: 'filled in' },
  { label: 'Repository access', value: 'Public repositories, or Only select for private ones', note: 'you choose' },
  { label: 'Resource owner', value: 'You, or the organization that owns private ones', note: 'you choose' },
] as const;
const READ_TOKEN_ACTION: OperatorActionOf<'onboarding'> = 'save-lane-read-token';

function hasConfiguredSecret(secretPath: 'github.readToken' | 'posthog.apiKey'): boolean {
  const payload = settingsPayloadSnapshot();
  const [section = '', key = ''] = secretPath.split('.');
  const block = payload[section];
  const isStored = typeof block === 'object' && block !== null && (block as Record<string, unknown>)[`${key}Configured`] === true;
  const sources = payload.secretSources;
  const isFromEnvironment = typeof sources === 'object' && sources !== null && typeof (sources as Record<string, unknown>)[secretPath] === 'string';
  return isStored || isFromEnvironment;
}

function hasLaneReadToken(): boolean {
  return hasConfiguredSecret(READ_TOKEN_PATH);
}

function laneReadTokenStepBody({ laneWork, onSaved }: { laneWork: string; onSaved: () => void }): HTMLElement[] {
  const inputId = 'lane-read-token-input';
  const label = el('label', 'repo-roots-adder-label', 'READ-ONLY TOKEN');
  label.htmlFor = inputId;
  const input = el('input', 'dialog-input repo-roots-adder-input');
  input.id = inputId;
  input.type = 'password';
  input.placeholder = 'github_pat_';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const actions = el('div', 'first-run-step-actions');
  const saveButton = button({ variant: 'primary', label: 'Save token', action: READ_TOKEN_ACTION });
  const status = createActionStatus();
  status.show('error', 'No token yet, so this lane stays off.');
  const save = async () => {
    const token = input.value.trim();
    if (!token) {
      status.show('error', 'Paste a GitHub token.');
      return;
    }
    sendControlMsg({ type: 'dashboard-telemetry', event: 'operator_action', properties: { surface: 'onboarding', action: READ_TOKEN_ACTION } });
    saveButton.disabled = true;
    status.show('busy', 'Saving');
    try {
      const reply = await sendControlRequest('update-settings', { settings: { github: { readToken: token } } }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
      if (reply.type === 'settings-error') {
        status.show('error', reply.message);
        return;
      }
      if (reply.type !== 'settings-updated') {
        status.show('error', 'The server did not confirm the save.');
        return;
      }
      applySettingsBroadcast(reply.settings);
      onSaved();
    } catch (reason) {
      status.show('error', requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS));
    } finally {
      saveButton.disabled = false;
    }
  };
  saveButton.addEventListener('click', () => { void save(); });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void save();
  });
  actions.append(saveButton, status.element);
  const advice = el('p', 'first-run-step-text', `${laneWork} It uses this token, never your own gh login. `);
  advice.append(externalLink('settings-link', 'Create a token on GitHub', FINE_GRAINED_TOKEN_URL));
  const settingsList = el('dl', 'lane-token-settings');
  for (const setting of TOKEN_SETTINGS) {
    settingsList.append(
      el('dt', 'lane-token-setting-label', setting.label),
      el('dd', 'lane-token-setting-value', setting.value),
      el('dd', 'lane-token-setting-note', setting.note),
    );
  }
  return [advice, settingsList, label, input, actions];
}

export { hasConfiguredSecret, hasLaneReadToken, laneReadTokenStepBody };
