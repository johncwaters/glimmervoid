import { el } from '../dom-helpers.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import type { SettingsSetting } from '#shared/settings/registry.ts';
import { isExperimentalSection, isExperimentalSetting } from '#shared/settings/registry.ts';
import { hasUnsavedEdit, isAtDefault, pageScopeOf, pageSectionOf, resetConfirmationOf, resetValueOf, rowChipsOf, secretEnvironmentSource, shouldShowDangerWarning } from './settings-view-core.ts';
import { settingsHash } from './settings-link.ts';
import { contentEl, draftByControl, fieldErrorById, pageSettings, replaceSettingsHash, saveStatusById, sectionOfSetting, selectedPage, settingsPayload, storedValue, viewMap } from './settings-panel-state.ts';
import { appendCopyControl, buildChip, buildExperimentalTag, buildStatusSlot, renderReadout } from './settings-readouts.ts';
import { commitSetting } from './settings-save.ts';
import { isTextField, renderControl } from './settings-controls.ts';

function renderSettingHeading(setting: SettingsSetting) {
  const row = el('div', 'settings-view-setting-heading');
  const section = sectionOfSetting(setting);
  const heading = el('h2', 'settings-view-setting-title', setting.title);
  heading.id = setting.id;
  if (isExperimentalSetting(setting) && !isExperimentalSection(pageSectionOf(viewMap, section.id) ?? section)) heading.append(' ', buildExperimentalTag());
  heading.addEventListener('click', () => replaceSettingsHash(section.id, setting.id));
  const copy = el('button', 'settings-view-copy-link', '#');
  copy.setAttribute('aria-label', 'Copy link');
  row.appendChild(heading);
  appendCopyControl(row, copy, {
    copiedText: 'Link copied',
    textToCopy: () => new URL(settingsHash(section.id, setting.id), location.href).href,
  });
  return row;
}

function pageScopeOfSetting(setting: SettingsSetting) {
  const page = pageSectionOf(viewMap, sectionOfSetting(setting).id);
  return page ? pageScopeOf(pageSettings(page)) : null;
}

function renderChips(setting: SettingsSetting, pageScope: SettingsSetting['scope'] | null) {
  const chips = el('div', 'settings-view-chips');
  for (const chip of rowChipsOf(setting, pageScope)) chips.appendChild(buildChip(chip.kind, chip.text));
  return chips;
}

function canReset(setting: SettingsSetting) {
  if (setting.control === 'readonly') return false;
  if (secretEnvironmentSource(setting, settingsPayload)) return false;
  return !isAtDefault(setting, storedValue(setting));
}

function renderControlFoot(setting: SettingsSetting) {
  const foot = el('div', 'settings-view-control-foot');
  const status = el('span', 'settings-view-save-status');
  status.setAttribute('role', 'status');
  const reset = el('button', 'settings-view-reset', 'Reset');
  reset.type = 'button';
  reset.title = 'Reset to the default value';
  reset.addEventListener('click', () => {
    const value = resetValueOf(setting);
    const confirmation = resetConfirmationOf(setting);
    if (confirmation !== null) {
      openConfirmDialog({ title: setting.title, message: confirmation, confirmLabel: 'Reset', danger: true, onConfirm: () => commitSetting(setting, value) });
      return;
    }
    commitSetting(setting, value);
  });
  foot.append(status, reset);
  return foot;
}

function applyFootState(row: Element, setting: SettingsSetting) {
  const status = row.querySelector<HTMLElement>('.settings-view-save-status');
  const saveStatus = saveStatusById.get(setting.id);
  if (status) {
    status.textContent = saveStatus?.text ?? '';
    if (saveStatus) status.dataset.tone = saveStatus.tone;
    if (!saveStatus) delete status.dataset.tone;
  }
  const reset = row.querySelector<HTMLButtonElement>('.settings-view-reset');
  if (reset) reset.hidden = !canReset(setting);
  const foot = row.querySelector<HTMLElement>('.settings-view-control-foot');
  if (foot) foot.hidden = !saveStatus && !canReset(setting);
  const existingError = row.querySelector<HTMLElement>('.settings-view-field-error');
  const error = fieldErrorById.get(setting.id);
  if (existingError && !error) existingError.remove();
  if (existingError && error) existingError.textContent = error;
  if (!existingError && error) row.querySelector('.settings-view-setting-control')?.appendChild(el('div', 'settings-view-field-error', error));
}

function renderRow(setting: SettingsSetting) {
  const article = el('article', 'settings-view-setting');
  article.dataset.settingId = setting.id;
  if (setting.control === 'readonly') article.dataset.readout = 'true';
  const text = el('div', 'settings-view-setting-text');
  text.append(renderSettingHeading(setting), el('p', 'settings-view-setting-description', setting.description));
  const chips = renderChips(setting, pageScopeOfSetting(setting));
  if (chips.childElementCount > 0) text.appendChild(chips);
  const control = el('div', 'settings-view-setting-control');
  control.appendChild(renderControl(setting));
  if (setting.control !== 'readonly') control.appendChild(renderControlFoot(setting));
  article.append(text, control);
  if (shouldShowDangerWarning(setting, storedValue(setting))) article.appendChild(el('div', 'settings-view-warning settings-warning', setting.warning));
  const statusSlot = buildStatusSlot(setting);
  if (statusSlot) article.appendChild(statusSlot);
  applyFootState(article, setting);
  return article;
}

function rowOf(setting: SettingsSetting): HTMLElement | null {
  return contentEl?.querySelector<HTMLElement>(`[data-setting-id="${setting.id}"]`) ?? null;
}

function focusControl(row: HTMLElement) {
  const control = row.querySelector<HTMLElement>('.settings-view-setting-control');
  if (!control) return;
  const target = control.querySelector<HTMLElement>('[data-restores-focus="true"]:not([disabled])')
    ?? control.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
    ?? control.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])');
  target?.focus();
}

function refreshFocusedField(current: Element, fresh: Element) {
  if (!isTextField(current) || !isTextField(fresh)) return;
  current.disabled = fresh.disabled;
  current.placeholder = fresh.placeholder;
  const freshDraft = draftByControl.get(fresh);
  if (!freshDraft || hasUnsavedEdit(draftByControl.get(current))) return;
  draftByControl.set(current, { base: freshDraft.base, isDirty: false });
  if (current.value !== fresh.value) current.value = fresh.value;
}

function refreshAroundDraft(current: Element, fresh: Element, focused: Element) {
  if (current === focused) {
    refreshFocusedField(current, fresh);
    return;
  }
  const currentChildren = [...current.children];
  const freshChildren = [...fresh.children];
  for (const [index, child] of freshChildren.entries()) {
    const previous = currentChildren[index];
    if (!previous) {
      current.appendChild(child);
      continue;
    }
    if (previous.contains(focused)) {
      refreshAroundDraft(previous, child, focused);
      continue;
    }
    previous.replaceWith(child);
  }
  for (const child of currentChildren.slice(freshChildren.length)) child.remove();
}

function refreshRow(setting: SettingsSetting, { force = false }: { force?: boolean } = {}) {
  const row = rowOf(setting);
  if (!row) return;
  const focused = document.activeElement;
  const hadFocus = row.contains(focused);
  const focusedField = hadFocus && !force && isTextField(focused) ? focused : null;
  if (!focusedField || !hasUnsavedEdit(draftByControl.get(focusedField))) fieldErrorById.delete(setting.id);
  const next = renderRow(setting);
  if (focusedField) {
    refreshAroundDraft(row, next, focusedField);
    return;
  }
  row.replaceWith(next);
  if (hadFocus) focusControl(next);
}

function refreshRowFoot(setting: SettingsSetting) {
  const row = rowOf(setting);
  if (row) applyFootState(row, setting);
}

function refreshReadout(setting: SettingsSetting) {
  rowOf(setting)?.querySelector('.settings-view-setting-control')?.replaceChildren(renderReadout(setting));
}

function refreshVisibleRows() {
  for (const setting of pageSettings(selectedPage)) {
    if (setting.control === 'readonly') {
      refreshReadout(setting);
      continue;
    }
    refreshRow(setting);
  }
}

function refreshRowStatusSlot(setting: SettingsSetting, row: Element) {
  const currentStatus = row.querySelector('.settings-view-status-slot');
  const nextStatus = buildStatusSlot(setting);
  if (currentStatus && nextStatus) currentStatus.replaceWith(nextStatus);
  if (currentStatus && !nextStatus) currentStatus.remove();
  if (!currentStatus && nextStatus) row.appendChild(nextStatus);
}

function refreshSettingsStatus() {
  for (const setting of pageSettings(selectedPage)) {
    if (!setting.status) continue;
    const row = rowOf(setting);
    if (!row) continue;
    if (setting.control === 'readonly') {
      refreshReadout(setting);
      continue;
    }
    refreshRowStatusSlot(setting, row);
  }
}

export { refreshReadout, refreshRow, refreshRowFoot, refreshSettingsStatus, refreshVisibleRows, renderChips, renderRow };
