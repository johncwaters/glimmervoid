import type { PackRow, PackSettingsView } from '#shared/contracts/control/pack-messages.ts';
import { packVaultName } from '#shared/contracts/secrets.ts';
import { DEFAULT_REPLY_TIMEOUT_MS, paintActionStatus, requestFailureText } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { field } from '../ui/field.ts';
import { sectionHeading } from '../ui/section-heading.ts';
import { textInput } from '../ui/text-input.ts';
import './pack-settings-view.css';

type SettingRow = PackRow['settings'][number];
type SettingsReply = { ok: true; settings: PackSettingsView } | { ok: false; error: string };
type SettingsRequest = (type: 'pack-settings-get' | 'pack-settings-save', payload: Record<string, unknown>) => Promise<SettingsReply>;
type FieldParts = { setting: SettingRow; input: HTMLInputElement; setHint: (text: string) => void };

async function requestSettings(type: 'pack-settings-get' | 'pack-settings-save', payload: Record<string, unknown>): Promise<SettingsReply> {
  try {
    const response = await sendControlRequest(type, payload, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
    if (response.type !== 'pack-settings-result') return { ok: false, error: 'Unexpected pack settings reply.' };
    if (!response.ok || response.settings === undefined) return { ok: false, error: response.error ?? 'Could not read the pack settings.' };
    return { ok: true, settings: response.settings };
  } catch (error) {
    return { ok: false, error: requestFailureText(error, DEFAULT_REPLY_TIMEOUT_MS) };
  }
}

function secretHint(setting: SettingRow, vaultName: string, view: PackSettingsView | null): string {
  if (view === null) return `Checking your vault for ${vaultName}`;
  const state = view.secretStateByKey[setting.key] ?? 'missing';
  if (view.manager === null) return `Set up a vault in Settings to keep ${vaultName}`;
  if (state === 'unreadable') return `Your vault could not be read for ${vaultName}; check the vault in Settings`;
  if (view.manager === '1password') return state === 'found' ? `Found in 1Password as ${vaultName}` : `Create ${vaultName} in 1Password; Glimmervoid never writes there`;
  return state === 'found' ? `Saved in your vault as ${vaultName}; paste a new key to replace it` : `Not set yet; saved to your vault as ${vaultName}`;
}

function missingText(view: PackSettingsView, settings: readonly SettingRow[]): string {
  if (view.missingKeys.length === 0) return 'All settings saved.';
  const labels = settings.filter((setting) => view.missingKeys.includes(setting.key)).map((setting) => setting.label);
  return `Still needed: ${labels.join(', ')}`;
}

function createFieldParts(row: PackRow, setting: SettingRow): { parts: FieldParts; element: HTMLElement } {
  const vaultName = packVaultName(row.name, setting.key);
  const isSecret = setting.kind === 'secret';
  const input = textInput({ type: isSecret ? 'password' : 'text', size: 'small', disabled: true, placeholder: isSecret ? 'Paste a key to save it' : '' });
  const hint = isSecret ? secretHint(setting, vaultName, null) : (setting.hint ?? setting.key);
  const built = field({ label: setting.label, control: input, hint });
  return { parts: { setting, input, setHint: built.setHint }, element: built.element };
}

export type PackSettingsSection = { element: HTMLElement; readIfUnread: () => void };

export function createPackSettingsView(row: PackRow, request: SettingsRequest = requestSettings): PackSettingsSection {
  const section = el('section', 'pack-settings');
  section.setAttribute('aria-label', `Settings of ${row.name}`);
  const heading = sectionHeading({ title: 'Settings', level: 3 });
  const fieldsByKey = new Map<string, FieldParts>();
  const fieldList = el('div', 'pack-settings-fields');
  for (const setting of row.settings) {
    const { parts, element } = createFieldParts(row, setting);
    fieldsByKey.set(setting.key, parts);
    fieldList.append(element);
  }
  const status = el('span', 'pack-settings-status');
  status.setAttribute('role', 'status');
  let isSaving = false;
  let currentView: PackSettingsView | null = null;

  function isReadOnly(parts: FieldParts): boolean {
    return parts.setting.kind === 'secret' && currentView?.manager !== 'age';
  }

  function paintDisabled(): void {
    for (const parts of fieldsByKey.values()) parts.input.disabled = isSaving || currentView === null || isReadOnly(parts);
    saveButton.disabled = isSaving || currentView === null;
  }

  function paintView(view: PackSettingsView): void {
    currentView = view;
    paintDisabled();
    for (const parts of fieldsByKey.values()) {
      if (parts.setting.kind === 'secret') {
        parts.input.value = '';
        parts.setHint(secretHint(parts.setting, view.vaultNameByKey[parts.setting.key] ?? packVaultName(row.name, parts.setting.key), view));
        continue;
      }
      parts.input.value = view.valuesByKey[parts.setting.key] ?? '';
    }
    paintActionStatus(status, view.missingKeys.length === 0 ? 'ok' : null, missingText(view, row.settings));
  }

  function enteredValues(): Record<string, string> {
    const entries = [...fieldsByKey.values()].flatMap((parts) => {
      if (isReadOnly(parts)) return [];
      if (parts.setting.kind === 'secret' && parts.input.value === '') return [];
      return [[parts.setting.key, parts.input.value]];
    });
    return Object.fromEntries(entries);
  }

  async function save(): Promise<void> {
    if (isSaving) return;
    const values = enteredValues();
    isSaving = true;
    paintDisabled();
    paintActionStatus(status, 'busy', 'Saving settings');
    const reply = await request('pack-settings-save', { pack: row.name, valuesByKey: values });
    isSaving = false;
    paintDisabled();
    if (!reply.ok) {
      paintActionStatus(status, 'error', reply.error);
      return;
    }
    paintView(reply.settings);
  }

  const saveButton = button({ variant: 'primary', size: 'small', label: 'Save settings', action: 'pack-settings-save', disabled: true, onClick: () => { void save(); } });
  const footer = el('div', 'pack-settings-footer');
  const statusLines = el('div', 'pack-settings-status-lines');
  statusLines.append(status);
  footer.append(saveButton, statusLines);
  section.append(heading.element, fieldList, footer);

  let isReading = false;
  function readIfUnread(): void {
    if (currentView !== null || isReading) return;
    isReading = true;
    paintActionStatus(status, 'busy', 'Reading settings');
    void request('pack-settings-get', { pack: row.name }).then((reply) => {
      isReading = false;
      if (!reply.ok) {
        paintActionStatus(status, 'error', reply.error);
        return;
      }
      paintView(reply.settings);
    });
  }
  readIfUnread();
  return { element: section, readIfUnread };
}
