import type { OperatorActionOf } from '#shared/contracts/control-messages.ts';
import { createActionStatus } from '../action-status.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el, externalLink } from '../dom-helpers.ts';
import { textInput } from '../ui/text-input.ts';
import { button } from '../ui/button.ts';
import { field } from '../ui/field.ts';
import updateSettingsAction from '../state/actions/update-settings.ts';
import { settingsPayloadSnapshot } from '../state/collections/settings.ts';

const READ_TOKEN_PATH = 'github.readToken' as const;
const FINE_GRAINED_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new?name=Glimmervoid+lanes+read-only&description=Read-only+GitHub+access+for+Glimmervoid+Community%2C+Team+review+and+Radar+research&expires_in=90&contents=read&issues=read&pull_requests=read';
const TOKEN_SETTINGS = [
  { label: 'Read-only', value: 'Contents, Issues, Pull requests', note: 'filled in' },
  { label: 'Expires', value: '90 days', note: 'filled in' },
  { label: 'Repositories', value: 'Public, or pick private ones', note: 'you choose' },
  { label: 'Owner', value: 'You, or their organization', note: 'you choose' },
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
  const input = textInput({ id: 'lane-read-token-input', type: 'password', placeholder: 'github_pat_' });
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
      const outcome = await updateSettingsAction({ settings: { github: { readToken: token } } });
      if (!outcome.ok) {
        status.show('error', outcome.error.message);
        return;
      }
      if (outcome.reply.type !== 'settings-updated') {
        status.show('error', 'The server did not confirm the save.');
        return;
      }
      onSaved();
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
  return [advice, settingsList, field({ label: 'Read-only token', control: input }).element, actions];
}

export { hasLaneReadToken, laneReadTokenStepBody };
