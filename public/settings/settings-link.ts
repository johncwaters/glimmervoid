import { el } from '../dom-helpers.ts';

export function settingsHash(sectionId: string, settingId: string | null = null) {
  return `#settings/${encodeURIComponent(sectionId)}${settingId ? `/${encodeURIComponent(settingId)}` : ''}`;
}

export function isSettingsHash(hash: string) {
  return /^#settings(?:[/?]|$)/.test(hash);
}

export function settingsSearchHash(query: string) {
  const term = query.trim();
  return term ? `#settings?q=${encodeURIComponent(term)}` : '#settings';
}

export function createSettingsLink(sectionId: string, settingId: string, label: string) {
  const link = el('a', 'settings-link', label);
  link.href = settingsHash(sectionId, settingId);
  return link;
}
