import { el } from '../dom-helpers.ts';

const MAX_SEARCH_QUERY_LENGTH = 200;

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

export function parseSettingsSearchHash(hash: unknown): { query: string } | null {
  const match = /^#settings(?:\?(.*))?$/.exec(String(hash ?? ''));
  if (!match) return null;
  const query = new URLSearchParams(match[1] ?? '').get('q') ?? '';
  return { query: Array.from(query.trim()).slice(0, MAX_SEARCH_QUERY_LENGTH).join('').trim() };
}

export function createSettingsLink(sectionId: string, settingId: string, label: string) {
  const link = el('a', 'settings-link', label);
  link.href = settingsHash(sectionId, settingId);
  return link;
}
