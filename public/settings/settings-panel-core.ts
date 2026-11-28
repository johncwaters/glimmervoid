import type { SettingsSection, SettingsSetting } from '#shared/settings/registry.ts';
import type { SettingsSearchMatch, SettingsSearchResult } from '#shared/settings/registry-core.ts';
import type { FeatureSurfaceRule } from '../feature-surfaces-core.ts';
import {
  fileOnlySearchCard,
  isSettingShown,
  pageSectionOf,
  rowChipsOf,
  settingsSearchBreadcrumb,
} from './settings-view-core.ts';
import type { SettingsPayload, SettingsRowChip, SettingsValues } from './settings-view-core.ts';

interface SettingsPanelState {
  selectedPageId: string;
  phoneSectionId: string | null;
  searchQuery: string;
  isAdvancedExpanded: boolean;
  isAnimalGalleryExpanded: boolean;
  fileOnlyOpenPageId: string | null;
}

type NavigationKeydownDecision =
  | { kind: 'ignore' }
  | { kind: 'choose-first-search' }
  | { kind: 'clear-search' }
  | { kind: 'move-nav'; nextIndex: number };

interface HighlightedTextPart {
  text: string;
  isMatch: boolean;
}

interface SearchResultRowDisplay {
  searchResult: SettingsSearchResult;
  sectionId: string | null;
  isFileOnly: boolean;
  breadcrumbParts: HighlightedTextPart[];
  titleParts: HighlightedTextPart[];
  descriptionParts: HighlightedTextPart[];
  pathParts: HighlightedTextPart[];
  extraHintParts: HighlightedTextPart[] | null;
  fileOnlyCurrentText: string | null;
  fileOnlyDefaultText: string | null;
  fileOnlyChips: SettingsRowChip[];
  fileOnlyJsonFragment: string | null;
}

interface FeatureListRowDisplay {
  sectionId: string;
  settingId: string;
  settingTitle: string;
  tabLabel: string;
  stateText: 'On' | 'Off';
  description: string;
}

type SettingsPageKind = 'shortcuts' | 'about' | 'status-key' | 'features' | 'hooks' | 'standard';

interface SettingsSpecialPageIds {
  shortcuts: string;
  about: string;
  statusKey: string;
  features: string;
  hooks: string;
}

const VISIBLE_SEARCH_FIELDS = new Set<SettingsSearchMatch['field']>(['title', 'description', 'path', 'section']);

export function createInitialSettingsPanelState(defaultPageId: string): SettingsPanelState {
  return {
    selectedPageId: defaultPageId,
    phoneSectionId: null,
    searchQuery: '',
    isAdvancedExpanded: false,
    isAnimalGalleryExpanded: false,
    fileOnlyOpenPageId: null,
  };
}

export function selectSectionTransition(
  state: SettingsPanelState,
  viewMap: readonly SettingsSection[],
  sectionId: string,
  options: { updateHash: boolean; openPhoneSection: boolean; isPhone: boolean },
): { state: SettingsPanelState; page: SettingsSection; isPageChange: boolean; shouldClearSearchInput: boolean } {
  const currentPage = pageSectionOf(viewMap, state.selectedPageId) ?? viewMap[0];
  const page = pageSectionOf(viewMap, sectionId) ?? currentPage;
  const isPageChange = currentPage.id !== page.id;
  const shouldClearSearchInput = options.updateHash && state.searchQuery !== '';
  const nextState: SettingsPanelState = {
    ...state,
    selectedPageId: page.id,
    searchQuery: shouldClearSearchInput ? '' : state.searchQuery,
    isAdvancedExpanded: isPageChange ? false : state.isAdvancedExpanded,
    phoneSectionId: options.openPhoneSection && options.isPhone ? page.id : state.phoneSectionId,
  };
  return { state: nextState, page, isPageChange, shouldClearSearchInput };
}

export function setSearchQueryTransition(state: SettingsPanelState, rawQuery: string): SettingsPanelState {
  return {
    ...state,
    searchQuery: rawQuery.trim(),
    phoneSectionId: null,
  };
}

export function clearPhoneSectionTransition(state: SettingsPanelState): SettingsPanelState {
  if (state.phoneSectionId === null) return state;
  return { ...state, phoneSectionId: null };
}

export function toggleAdvancedTransition(state: SettingsPanelState): SettingsPanelState {
  return { ...state, isAdvancedExpanded: !state.isAdvancedExpanded };
}

export function expandAdvancedTransition(state: SettingsPanelState): SettingsPanelState {
  if (state.isAdvancedExpanded) return state;
  return { ...state, isAdvancedExpanded: true };
}

export function toggleAnimalGalleryTransition(state: SettingsPanelState): SettingsPanelState {
  return { ...state, isAnimalGalleryExpanded: !state.isAnimalGalleryExpanded };
}

export function setFileOnlyOpenTransition(state: SettingsPanelState, pageId: string, isOpen: boolean): SettingsPanelState {
  const nextPageId = isOpen ? pageId : (state.fileOnlyOpenPageId === pageId ? null : state.fileOnlyOpenPageId);
  if (nextPageId === state.fileOnlyOpenPageId) return state;
  return { ...state, fileOnlyOpenPageId: nextPageId };
}

export function decideNavigationKeydown(
  key: string,
  isSearchTarget: boolean,
  searchQuery: string,
  currentNavIndex: number,
  navCount: number,
  isComposing: boolean,
): NavigationKeydownDecision {
  if (isComposing) return { kind: 'ignore' };
  if (searchQuery !== '' && key === 'Enter' && isSearchTarget) return { kind: 'choose-first-search' };
  if (key === 'Escape' && searchQuery !== '') return { kind: 'clear-search' };
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return { kind: 'ignore' };
  if (currentNavIndex < 0 || navCount <= 0) return { kind: 'ignore' };
  const direction = key === 'ArrowDown' ? 1 : -1;
  return { kind: 'move-nav', nextIndex: (currentNavIndex + direction + navCount) % navCount };
}

export function highlightedSearchPartsOf(
  text: string,
  searchResult: SettingsSearchResult,
  field: SettingsSearchMatch['field'],
): HighlightedTextPart[] {
  const match = searchResult.matches.find((entry) => entry.field === field);
  const offset = match ? text.indexOf(match.text) : -1;
  if (!match || offset < 0) return [{ text, isMatch: false }];
  const parts: HighlightedTextPart[] = [];
  let cursor = 0;
  for (const span of match.spans) {
    const start = offset + span.start;
    const end = offset + span.end;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), isMatch: false });
    parts.push({ text: text.slice(start, end), isMatch: true });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), isMatch: false });
  return parts;
}

export function searchResultsDisplayOf(
  viewMap: readonly SettingsSection[],
  searchResults: readonly SettingsSearchResult[],
  payload: SettingsPayload,
): SearchResultRowDisplay[] {
  return searchResults.map((searchResult) => {
    const breadcrumb = settingsSearchBreadcrumb(viewMap, searchResult.section, searchResult.setting);
    const hasVisibleMatch = searchResult.matches.some((match) => VISIBLE_SEARCH_FIELDS.has(match.field));
    const fallbackMatch = hasVisibleMatch
      ? undefined
      : (searchResult.matches.find((entry) => entry.field === 'options') ?? searchResult.matches.find((entry) => entry.field === 'keywords'));
    const isFileOnly = searchResult.section === null;
    const fileOnlyDetails = isFileOnly ? fileOnlySearchCard(searchResult.setting, payload) : null;
    return {
      searchResult,
      sectionId: searchResult.section?.id ?? null,
      isFileOnly,
      breadcrumbParts: highlightedSearchPartsOf(breadcrumb, searchResult, 'section'),
      titleParts: highlightedSearchPartsOf(searchResult.setting.title, searchResult, 'title'),
      descriptionParts: highlightedSearchPartsOf(searchResult.setting.description, searchResult, 'description'),
      pathParts: highlightedSearchPartsOf(searchResult.setting.path, searchResult, 'path'),
      extraHintParts: fallbackMatch ? highlightedSearchPartsOf(fallbackMatch.text, searchResult, fallbackMatch.field) : null,
      fileOnlyCurrentText: fileOnlyDetails?.currentText ?? null,
      fileOnlyDefaultText: fileOnlyDetails?.defaultText ?? null,
      fileOnlyChips: isFileOnly ? rowChipsOf(searchResult.setting, null) : [],
      fileOnlyJsonFragment: fileOnlyDetails?.jsonFragment ?? null,
    };
  });
}

export function featureListRowsOf(
  surfaces: readonly { sectionId: string; settingId: string; rule: string }[],
  viewMap: readonly SettingsSection[],
  settingLookup: (settingId: string) => SettingsSetting | null,
  storedValueLookup: (setting: SettingsSetting) => unknown,
  ruleLookup: Readonly<Record<string, FeatureSurfaceRule>>,
  tabLabelLookup: (rule: FeatureSurfaceRule) => string | undefined,
): FeatureListRowDisplay[] {
  const rows: FeatureListRowDisplay[] = [];
  for (const surface of surfaces) {
    const section = viewMap.find((entry) => entry.id === surface.sectionId);
    const enableSetting = settingLookup(surface.settingId);
    const rule = ruleLookup[surface.rule];
    const tabLabel = rule ? tabLabelLookup(rule) : undefined;
    if (!section || !enableSetting || !tabLabel) continue;
    const isOn = storedValueLookup(enableSetting) === true;
    rows.push({
      sectionId: surface.sectionId,
      settingId: surface.settingId,
      settingTitle: enableSetting.title,
      tabLabel,
      stateText: isOn ? 'On' : 'Off',
      description: section.description,
    });
  }
  return rows;
}

export function aboutVersionTextOf(appVersion: unknown): string {
  if (typeof appVersion === 'string' && appVersion !== '') return `v${appVersion}`;
  return 'version unknown';
}

export function pageKindOf(pageId: string, specialIds: SettingsSpecialPageIds): SettingsPageKind {
  if (pageId === specialIds.shortcuts) return 'shortcuts';
  if (pageId === specialIds.about) return 'about';
  if (pageId === specialIds.statusKey) return 'status-key';
  if (pageId === specialIds.features) return 'features';
  if (pageId === specialIds.hooks) return 'hooks';
  return 'standard';
}

export function visibleSettingsSplitOf(
  part: SettingsSection,
  storedValues: SettingsValues,
  payload: SettingsPayload,
): { regular: SettingsSetting[]; advanced: SettingsSetting[] } {
  const regular: SettingsSetting[] = [];
  const advanced: SettingsSetting[] = [];
  for (const entry of part.settings) {
    if (!isSettingShown(entry, storedValues, payload)) continue;
    if (entry.access === 'advanced') {
      advanced.push(entry);
      continue;
    }
    regular.push(entry);
  }
  return { regular, advanced };
}

export function isAlertSoundPage(page: SettingsSection): boolean {
  return page.settings.some((setting) => setting.path === 'pref:soundId');
}
