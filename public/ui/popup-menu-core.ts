import { nextRovingIndex } from '../roving-keys-core.ts';

export type MenuItemTone = 'neutral' | 'warning' | 'danger';
export type MenuItemRole = 'menuitem' | 'menuitemcheckbox' | 'menuitemradio';

interface MenuItemDescriptorOptions {
  label: string;
  className?: string;
  tone?: MenuItemTone;
  role?: MenuItemRole;
  checked?: boolean;
}

interface MenuItemDescriptor {
  className: string;
  role: MenuItemRole;
  tone: MenuItemTone | null;
  label: string;
  ariaChecked?: 'true' | 'false';
}

interface PopupMenuStateAttributes {
  hidden: boolean;
  dataState: 'open' | 'closed';
  ariaExpanded: 'true' | 'false';
}

const TYPEAHEAD_RESET_MS = 500;

export function menuItemDescriptor(options: MenuItemDescriptorOptions): MenuItemDescriptor {
  const extraClassName = options.className?.trim() ?? '';
  const className = extraClassName ? `popup-menu-item ${extraClassName}` : 'popup-menu-item';
  const role = options.role ?? 'menuitem';
  const tone = options.tone && options.tone !== 'neutral' ? options.tone : null;
  const descriptor: MenuItemDescriptor = {
    className,
    role,
    tone,
    label: options.label,
  };
  if ((role === 'menuitemcheckbox' || role === 'menuitemradio') && options.checked !== undefined) {
    descriptor.ariaChecked = options.checked ? 'true' : 'false';
  }
  return descriptor;
}

export function popupMenuStateAttributes(isOpen: boolean): PopupMenuStateAttributes {
  return {
    hidden: !isOpen,
    dataState: isOpen ? 'open' : 'closed',
    ariaExpanded: isOpen ? 'true' : 'false',
  };
}

export function isMenuArrowKey(key: string): boolean {
  return key === 'ArrowDown' || key === 'ArrowUp';
}

export function isMenuJumpKey(key: string): boolean {
  return key === 'Home' || key === 'End';
}

export function isTypeaheadKey(key: string, hasModifier: boolean): boolean {
  if (hasModifier) return false;
  if (key.length !== 1) return false;
  return key.trim().length > 0;
}

export function nextMenuItemIndex(key: string, currentIndex: number, count: number): number | null {
  return nextRovingIndex(key, currentIndex, count, 'vertical');
}

export function nextTypeaheadQuery(
  previousQuery: string,
  key: string,
  elapsedMs: number,
  resetMs = TYPEAHEAD_RESET_MS,
): string {
  const normalizedKey = key.toLowerCase();
  if (previousQuery === '' || elapsedMs > resetMs) return normalizedKey;
  return previousQuery + normalizedKey;
}

function findPrefixMatch(
  normalizedLabels: readonly string[],
  prefix: string,
  startIndex: number,
): number | null {
  const count = normalizedLabels.length;
  for (let offset = 0; offset < count; offset += 1) {
    const candidateIndex = (startIndex + offset) % count;
    if (normalizedLabels[candidateIndex].startsWith(prefix)) return candidateIndex;
  }
  return null;
}

export function findTypeaheadIndex(
  labels: readonly string[],
  query: string,
  currentIndex: number,
): number | null {
  const count = labels.length;
  const normalizedQuery = query.trim().toLowerCase();
  if (count === 0 || normalizedQuery.length === 0) return null;

  const normalizedLabels = labels.map((label) => label.trim().toLowerCase());
  const nextStart = currentIndex >= 0 ? (currentIndex + 1) % count : 0;

  if (normalizedQuery.length === 1) {
    return findPrefixMatch(normalizedLabels, normalizedQuery, nextStart);
  }

  const keepCurrentStart = currentIndex >= 0 ? currentIndex : 0;
  const exactPrefixMatch = findPrefixMatch(normalizedLabels, normalizedQuery, keepCurrentStart);
  if (exactPrefixMatch !== null) return exactPrefixMatch;

  const firstCharacter = normalizedQuery[0];
  const isRepeatedCharacter = [...normalizedQuery].every((character) => character === firstCharacter);
  if (!isRepeatedCharacter) return null;
  return findPrefixMatch(normalizedLabels, firstCharacter, nextStart);
}
