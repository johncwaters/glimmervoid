import './settings-panel.css';
import { renderFlyingAnimalsGallery } from '../flying-animals-gallery.ts';
import { isPhoneLayout, onLayoutChange } from '../form-factor.ts';
import { REPO_SLUG } from '#shared/repo.ts';
import { loadCustomSounds, resolveSoundId } from '../alert-sound.ts';
import { el } from '../dom-helpers.ts';
import { BACK_ICON_PATH, createLineIcon } from '../svg-dom.ts';
import { UPDATES_SECTION_ID } from '../radar/radar-core.ts';
import type { SettingsSection, SettingsSetting } from '#shared/settings/registry.ts';
import { isExperimentalSection, SETTINGS_MOVED_SETTINGS, SETTINGS_REGISTRY, SETTINGS_SECTION_ALIASES } from '#shared/settings/registry.ts';
import type { SettingsSearchMatch, SettingsSearchResult } from '#shared/settings/registry-core.ts';
import { parseSettingsHash, scoreSettingsSearch } from '#shared/settings/registry-core.ts';
import { SCOPE_LABELS, fileOnlySearchCard, pageScopeOf, pageSectionOf, phoneSettingsScreenOf, settingsNavigationGroupsOf, settingsSearchBreadcrumb, topLevelSectionsOf } from './settings-view-core.ts';
import { createSettingsLink, parseSettingsSearchHash, settingsSearchHash } from './settings-link.ts';
import { FEATURE_SURFACE_RULES, OPTIONAL_FEATURE_SURFACES } from '../feature-surfaces-core.ts';
import type { FeatureSurfaceRule } from '../feature-surfaces-core.ts';
import type { ViewModule } from '../view-registry-core.ts';
import { appendShortcutChord, currentNextAttentionKeyCode, SHORTCUT_PLATFORM } from '../shortcuts.ts';
import { isStreamerMode, onStreamerModeChanged, saveStreamerMode } from '../streamer-mode.ts';
import { shortcutGroupsFor } from '../shortcuts-core.ts';
import { renderPrStatusLegend, renderStatusLegend } from '../status-legend.ts';
import { applyFlyingAnimals } from '../flying-animals.ts';
import { isFlyingAnimalsEnabled, resetFlyingAnimalsAdvanced, getSoundId } from '../ui-prefs.ts';
import { notifyPhoneSettingsScreenChanged, setPhoneSettingsScreenProbe, settingsFeatureTabViews, settingsPayloadSnapshot, subscribeSettings, takePendingSettingsActivation, returnToSettingsList } from './settings-store.ts';
import type { SettingsChange } from './settings-store.ts';
import { onSoundEnabledChange } from '../mute-button.ts';
import { onAgentLoginsChanged } from '../dialogs.ts';
import { ABOUT_PAGE_ID, availableSettingsSections, contentEl, FEATURES_PAGE_ID, hydrate, isAutoUpdateCheckAwaitingStatus, pageParts, pageSettings, rebuildSettingsViewMap, replaceSettingsHash, selectedPage, setContentEl, setPanelRefresher, setSelectedPage, setSettingsPayload, settingById, settingsPayload, SHORTCUTS_PAGE_ID, STATUS_KEY_PAGE_ID, storedValue, storedValues, syncSettingsViewMapToBuild, viewMap, websiteUrl } from './settings-panel-state.ts';
import { checkUpdatesIfStale } from './settings-update-status.ts';
import { appendCopyControl, buildChip, buildExperimentalTag, externalLink } from './settings-readouts.ts';
import { refreshReadout, refreshRow, refreshRowFoot, refreshSettingsStatus, refreshVisibleRows, renderChips, renderRow } from './settings-rows.ts';

type SectionSearchResult = SettingsSearchResult & { section: SettingsSection };

const APPEARANCE_PAGE_ID = 'browser-appearance';
const FLYING_ANIMALS_SETTING_ID = 'flying-animals';
let isAdvancedSettingsExpanded = false;
let isAnimalGalleryExpanded = false;
let rootEl: HTMLElement | null = null;
let settingsViewVisibilityObserver: IntersectionObserver | null = null;
let shellEl: HTMLDivElement | null = null;
let navigationEl: HTMLElement | null = null;
let searchEl: HTMLInputElement | null = null;
let phoneSectionId: string | null = null;
let backButtonEl: HTMLButtonElement | null = null;
let searchQuery = '';

function flashSetting(settingId: string) {
  requestAnimationFrame(() => {
    const heading = document.getElementById(settingId);
    const panel = heading?.closest<HTMLElement>('.settings-view-advanced-panel');
    if (panel) {
      isAdvancedSettingsExpanded = true;
      panel.hidden = false;
      contentEl?.querySelector('.settings-view-advanced-toggle')?.setAttribute('aria-expanded', 'true');
    }
    const row = heading?.closest('.settings-view-setting');
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    row.classList.remove('settings-view-setting-flash');
    requestAnimationFrame(() => row.classList.add('settings-view-setting-flash'));
  });
}

function renderShortcutGroups(container: HTMLElement) {
  container.replaceChildren();
  for (const group of shortcutGroupsFor(SHORTCUT_PLATFORM, currentNextAttentionKeyCode())) {
    const groupEl = el('div', 'shortcut-group');
    groupEl.appendChild(el('h2', 'settings-view-subsection-title', group.title));
    const rows = el('dl', 'shortcut-rows');
    for (const item of group.items) {
      const keys = el('dd', 'shortcut-keys');
      item.combos.forEach((chord, chordIndex) => {
        if (chordIndex > 0) keys.appendChild(el('span', 'shortcut-sep', '/'));
        appendShortcutChord(keys, chord);
      });
      rows.append(el('dt', 'shortcut-label', item.label), keys);
    }
    groupEl.appendChild(rows);
    container.appendChild(groupEl);
  }
}

function featureTabLabel(rule: FeatureSurfaceRule) {
  return settingsFeatureTabViews().find((view) => view.gate !== undefined && 'fromSettings' in view.gate && view.gate.fromSettings === rule)?.label;
}

function renderFeatureList(container: HTMLElement) {
  const list = el('ul', 'settings-view-stack settings-features');
  for (const surface of OPTIONAL_FEATURE_SURFACES) {
    const section = viewMap.find((entry) => entry.id === surface.sectionId);
    const enableSetting = settingById(surface.settingId);
    const tabLabel = featureTabLabel(FEATURE_SURFACE_RULES[surface.rule]);
    if (!section || !enableSetting || !tabLabel) continue;
    const isOn = storedValue(enableSetting) === true;
    const item = el('li', 'settings-feature');
    const head = el('div', 'settings-feature-head');
    head.append(el('span', 'settings-feature-name', tabLabel), buildChip('feature', isOn ? 'On' : 'Off'));
    item.append(head, el('p', 'settings-view-section-description', section.description), createSettingsLink(surface.sectionId, surface.settingId, enableSetting.title));
    list.appendChild(item);
  }
  container.appendChild(list);
}

function renderAbout(container: HTMLElement) {
  const about = el('div', 'settings-about');
  const version = typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? `v${__APP_VERSION__}` : 'version unknown';
  const versionEl = el('span', 'settings-about-version', 'GLIMMERVOID ');
  versionEl.appendChild(el('span', 'settings-about-v', version));
  const links = el('span', 'settings-about-links');
  links.append(
    externalLink('GitHub', `https://github.com/${REPO_SLUG}`),
    externalLink('Changelog', `https://github.com/${REPO_SLUG}/blob/main/CHANGELOG.md`),
    externalLink('Website', websiteUrl('/')),
  );
  about.append(versionEl, links);
  container.appendChild(about);
}

function syncSoundEnabledValue(enabled: boolean) {
  if (storedValues['pref:soundEnabled'] === enabled) return;
  storedValues['pref:soundEnabled'] = enabled;
  const setting = settingById('alert-sounds-enabled');
  if (setting) refreshRow(setting);
}

function renderFlyingAnimalsReset() {
  const reset = el('button', 'btn-dialog btn-dialog-cancel', 'Reset all to defaults');
  reset.type = 'button';
  reset.addEventListener('click', () => {
    resetFlyingAnimalsAdvanced();
    hydrate(settingsPayload);
    applyFlyingAnimals(isFlyingAnimalsEnabled());
    renderContent();
  });
  return reset;
}

function renderAdvancedSettings(advancedSettings: SettingsSetting[]) {
  const advanced = el('div', 'settings-view-advanced');
  const toggle = el('button', 'dialog-advanced-toggle settings-view-advanced-toggle', 'Advanced');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(isAdvancedSettingsExpanded));
  toggle.setAttribute('aria-controls', 'settings-view-advanced-panel');
  const panel = el('div', 'dialog-advanced-panel settings-view-advanced-panel');
  panel.id = 'settings-view-advanced-panel';
  panel.hidden = !isAdvancedSettingsExpanded;
  toggle.addEventListener('click', () => {
    isAdvancedSettingsExpanded = !isAdvancedSettingsExpanded;
    panel.hidden = !isAdvancedSettingsExpanded;
    toggle.setAttribute('aria-expanded', String(isAdvancedSettingsExpanded));
  });
  for (const setting of advancedSettings) panel.append(renderRow(setting));
  if (selectedPage.id === APPEARANCE_PAGE_ID) panel.append(renderFlyingAnimalsReset());
  advanced.append(toggle, panel);
  return advanced;
}

function renderStreamerPlaceholder(container: HTMLElement) {
  const placeholder = el('div', 'settings-view-streamer-placeholder');
  const turnOff = el('button', 'btn-dialog btn-dialog-confirm', 'Turn off streamer mode');
  turnOff.type = 'button';
  const status = el('span', 'settings-view-copy-status', '');
  status.setAttribute('role', 'status');
  turnOff.addEventListener('click', async () => {
    turnOff.disabled = true;
    status.textContent = '';
    const saveError = await saveStreamerMode(false);
    turnOff.disabled = false;
    status.textContent = saveError;
  });
  placeholder.append(el('p', 'settings-view-section-description', 'Settings are hidden in streamer mode.'), turnOff, status);
  container.appendChild(placeholder);
}

onStreamerModeChanged(() => renderContent());

function renderAnimalGalleryToggle() {
  const disclosure = el('div', 'settings-view-advanced');
  const toggle = el('button', 'dialog-advanced-toggle', 'Animal gallery');
  toggle.type = 'button';
  toggle.setAttribute('aria-controls', 'settings-view-animal-gallery-panel');
  const panel = el('div', 'dialog-advanced-panel settings-view-advanced-panel');
  panel.id = 'settings-view-animal-gallery-panel';
  const showExpandedState = () => {
    toggle.setAttribute('aria-expanded', String(isAnimalGalleryExpanded));
    panel.hidden = !isAnimalGalleryExpanded;
    if (isAnimalGalleryExpanded && panel.childElementCount === 0) panel.append(renderFlyingAnimalsGallery());
  };
  toggle.addEventListener('click', () => {
    isAnimalGalleryExpanded = !isAnimalGalleryExpanded;
    showExpandedState();
  });
  showExpandedState();
  disclosure.append(toggle, panel);
  return disclosure;
}

function renderSubsectionHeader(section: SettingsSection) {
  const header = el('header', 'settings-view-subsection');
  const title = el('h2', 'settings-view-subsection-title', section.title);
  title.addEventListener('click', () => replaceSettingsHash(section.id));
  header.append(title, el('p', 'settings-view-section-description', section.description));
  return header;
}

function renderPart(stack: HTMLElement, part: SettingsSection) {
  for (const setting of part.settings.filter((entry) => entry.access !== 'advanced')) {
    stack.appendChild(renderRow(setting));
    if (setting.id === FLYING_ANIMALS_SETTING_ID) stack.appendChild(renderAnimalGalleryToggle());
  }
  const advancedSettings = part.settings.filter((entry) => entry.access === 'advanced');
  if (advancedSettings.length > 0) stack.append(renderAdvancedSettings(advancedSettings));
}

function renderContent() {
  syncPhoneSettingsScreen();
  if (searchQuery) {
    renderSearchContent();
    return;
  }
  if (!contentEl) return;
  contentEl.textContent = '';
  if (isStreamerMode()) {
    renderStreamerPlaceholder(contentEl);
    return;
  }
  const header = el('header', 'settings-view-section-header');
  const title = el('h1', 'settings-view-section-title', selectedPage.title);
  title.tabIndex = -1;
  title.addEventListener('click', () => replaceSettingsHash(selectedPage.id));
  const titleRow = el('div', 'settings-view-section-title-row');
  titleRow.appendChild(title);
  const isExperimentalPage = isExperimentalSection(selectedPage);
  if (isExperimentalPage) title.append(' ', buildExperimentalTag());
  const pageScope = pageScopeOf(pageSettings(selectedPage));
  if (pageScope) titleRow.appendChild(buildChip('scope', SCOPE_LABELS[pageScope]));
  header.append(titleRow, el('p', 'settings-view-section-description', selectedPage.description));
  if (isExperimentalPage) header.appendChild(el('p', 'settings-view-warning settings-view-experimental-caution', 'Experimental: this may change or break between releases.'));
  contentEl.appendChild(header);

  if (selectedPage.id === SHORTCUTS_PAGE_ID) {
    const stack = el('div', 'settings-view-stack');
    renderPart(stack, selectedPage);
    contentEl.appendChild(stack);
    const groups = el('div', 'shortcut-groups settings-view-shortcuts');
    renderShortcutGroups(groups);
    contentEl.appendChild(groups);
    return;
  }

  if (selectedPage.id === ABOUT_PAGE_ID) {
    renderAbout(contentEl);
    return;
  }

  if (selectedPage.id === STATUS_KEY_PAGE_ID) {
    contentEl.appendChild(renderStatusLegend());
    contentEl.appendChild(renderPrStatusLegend());
    return;
  }

  if (selectedPage.id === FEATURES_PAGE_ID) {
    renderFeatureList(contentEl);
    return;
  }

  const stack = el('div', 'settings-view-stack');
  for (const part of pageParts(selectedPage)) {
    if (part.id !== selectedPage.id) stack.appendChild(renderSubsectionHeader(part));
    renderPart(stack, part);
  }
  contentEl.appendChild(stack);
}

function selectSection(
  sectionId: string,
  { focusContent = false, settingId = null, updateHash = true, openPhoneSection = true }: { focusContent?: boolean; settingId?: string | null; updateHash?: boolean; openPhoneSection?: boolean } = {}
) {
  if (updateHash && searchQuery) {
    searchQuery = '';
    if (searchEl) searchEl.value = '';
  }
  const page = pageSectionOf(viewMap, sectionId) ?? selectedPage;
  if (selectedPage.id !== page.id) isAdvancedSettingsExpanded = false;
  setSelectedPage(page);
  const targetSection = viewMap.find((section) => section.id === sectionId) ?? page;
  markCurrentSection(navigationEl);
  if (openPhoneSection && isPhoneLayout()) phoneSectionId = targetSection.id;
  renderContent();
  if (isAlertSoundPage(selectedPage)) reloadCustomSounds();
  if (selectedPage.id === UPDATES_SECTION_ID) checkUpdatesIfStale();
  if (updateHash) replaceSettingsHash(targetSection.id, settingId);
  if (settingId) flashSetting(settingId);
  if (focusContent) contentEl?.querySelector('h1')?.focus();
}

function markCurrentSection(container: Element | null) {
  for (const button of container?.querySelectorAll<HTMLElement>('[data-settings-section]') || []) {
    const selected = button.dataset.settingsSection === selectedPage.id;
    button.setAttribute('aria-current', selected ? 'page' : 'false');
  }
}

function hasSection(result: SettingsSearchResult): result is SectionSearchResult {
  return result.section !== null;
}

function chooseSearchResult(searchResult: SectionSearchResult) {
  if (!searchEl) return;
  searchEl.value = '';
  searchQuery = '';
  renderNavigation();
  selectSection(searchResult.section.id, { settingId: searchResult.setting.id });
}

function searchSettings(query: string) {
  return scoreSettingsSearch(availableSettingsSections(), query, SETTINGS_REGISTRY.fileOnly);
}

function highlightedSearchText(
  tag: 'span' | 'p' | 'code', className: string, text: string, result: SettingsSearchResult, field: SettingsSearchMatch['field'],
) {
  const element = el(tag, className);
  const match = result.matches.find((entry) => entry.field === field);
  const offset = match ? text.indexOf(match.text) : -1;
  if (!match || offset < 0) {
    element.textContent = text;
    return element;
  }
  let cursor = 0;
  for (const span of match.spans) {
    element.append(text.slice(cursor, offset + span.start), el('mark', 'settings-view-search-highlight', text.slice(offset + span.start, offset + span.end)));
    cursor = offset + span.end;
  }
  element.append(text.slice(cursor));
  return element;
}

function appendFileOnlyDetails(row: HTMLElement, result: SettingsSearchResult) {
  const { currentText, defaultText, jsonFragment } = fileOnlySearchCard(result.setting, settingsPayload);
  if (currentText !== null) row.appendChild(el('span', 'settings-view-search-current', currentText));
  row.append(
    el('span', 'settings-view-search-default', defaultText),
    renderChips(result.setting, null),
    el('p', 'settings-view-list-hint', 'Edit in config.json or with glimmervoid settings set.'),
  );
  if (jsonFragment === null) return;
  const actions = el('div', 'settings-view-control-foot');
  appendCopyControl(actions, el('button', 'settings-view-copy-json', 'Copy as JSON'), { copiedText: 'JSON copied', textToCopy: () => jsonFragment });
  row.appendChild(actions);
}

function renderSearchContent() {
  if (!contentEl) return;
  contentEl.textContent = '';
  if (isStreamerMode()) {
    renderStreamerPlaceholder(contentEl);
    return;
  }
  const results = searchSettings(searchQuery);
  const header = el('div', 'settings-view-section-header');
  header.append(el('h1', 'settings-view-section-title', 'Settings search'), el('p', 'settings-view-section-description', `${results.length} ${results.length === 1 ? 'result' : 'results'} for "${searchQuery}"`));
  contentEl.appendChild(header);
  if (results.length === 0) {
    contentEl.appendChild(el('p', 'settings-empty settings-view-search-empty', 'No settings found.'));
    return;
  }
  const list = el('ol', 'settings-view-search-results');
  list.setAttribute('aria-label', 'Settings search results');
  for (const result of results) {
    const row = el('li', 'settings-view-search-result');
    row.tabIndex = -1;
    const breadcrumb = settingsSearchBreadcrumb(viewMap, result.section, result.setting);
    row.appendChild(highlightedSearchText('p', 'settings-view-search-breadcrumb', breadcrumb, result, 'section'));
    const title = highlightedSearchText('span', 'settings-view-setting-title', result.setting.title, result, 'title');
    if (hasSection(result)) {
      const open = el('button', 'settings-view-search-open');
      open.type = 'button';
      open.appendChild(title);
      open.addEventListener('click', () => chooseSearchResult(result));
      row.appendChild(open);
    }
    if (!hasSection(result)) {
      row.classList.add('settings-view-search-file-only');
      row.appendChild(title);
    }
    row.append(
      highlightedSearchText('p', 'settings-view-setting-description', result.setting.description, result, 'description'),
      highlightedSearchText('code', 'settings-view-key-path', result.setting.path, result, 'path'),
    );
    const visibleFields = new Set(['title', 'description', 'path', 'section']);
    if (!result.matches.some((match) => visibleFields.has(match.field))) {
      const match = result.matches.find((entry) => entry.field === 'options') ?? result.matches.find((entry) => entry.field === 'keywords');
      if (match) row.appendChild(highlightedSearchText('p', 'settings-view-list-hint', match.text, result, match.field));
    }
    if (!hasSection(result)) appendFileOnlyDetails(row, result);
    list.appendChild(row);
  }
  contentEl.appendChild(list);
}

function currentPhoneSettingsScreen() {
  return phoneSettingsScreenOf(viewMap, phoneSectionId, searchQuery, isStreamerMode());
}

function syncPhoneSettingsScreen() {
  if (!shellEl) return;
  const screen = currentPhoneSettingsScreen();
  const hasScreenChanged = shellEl.dataset.settingsScreen !== screen;
  shellEl.dataset.settingsScreen = screen;
  if (backButtonEl) backButtonEl.hidden = screen !== 'section';
  if (!hasScreenChanged) return;
  notifyPhoneSettingsScreenChanged();
}

function returnToList() {
  const previousPageId = selectedPage.id;
  setSearchQuery('');
  navigationEl?.querySelector<HTMLElement>(`[data-settings-section="${previousPageId}"]`)?.focus();
}

function renderNavigation() {
  if (!navigationEl || !shellEl) return;
  navigationEl.textContent = '';
  for (const navigationGroup of settingsNavigationGroupsOf(topLevelSectionsOf(viewMap))) {
    const group = el('div', 'settings-view-nav-group');
    if (navigationGroup.heading) group.appendChild(el('div', 'settings-view-nav-heading', navigationGroup.heading));
    for (const section of navigationGroup.sections) {
      const button = el('button', 'settings-view-nav-item', section.title);
      button.type = 'button';
      if (isExperimentalSection(section)) button.append(' ', buildExperimentalTag());
      button.dataset.settingsSection = section.id;
      button.addEventListener('click', () => selectSection(section.id, { focusContent: isPhoneLayout() }));
      group.appendChild(button);
    }
    navigationEl.appendChild(group);
  }
  if (searchQuery) {
    syncPhoneSettingsScreen();
    renderSearchContent();
    return;
  }
  selectSection(selectedPage.id, { updateHash: false, openPhoneSection: false });
}

function setSearchQuery(query: string, { updateHash = true } = {}) {
  searchQuery = query.trim();
  if (searchEl) searchEl.value = query;
  phoneSectionId = null;
  if (updateHash) history.replaceState(history.state, '', settingsSearchHash(searchQuery));
  renderNavigation();
}

function handleNavigationKeydown(event: KeyboardEvent) {
  if (searchQuery && event.key === 'Enter' && event.target === searchEl) {
    const first = searchSettings(searchQuery).find(hasSection);
    if (!first) return;
    event.preventDefault();
    chooseSearchResult(first);
    return;
  }
  if (event.key === 'Escape' && searchQuery) {
    if (!searchEl) return;
    event.preventDefault();
    setSearchQuery('');
    searchEl.focus();
    return;
  }
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  if (!navigationEl) return;
  const buttons = [...navigationEl.querySelectorAll('[data-settings-section]')]
    .filter((button): button is HTMLElement => button instanceof HTMLElement);
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return;
  const currentIndex = buttons.indexOf(activeElement);
  if (currentIndex < 0) return;
  event.preventDefault();
  const direction = event.key === 'ArrowDown' ? 1 : -1;
  buttons[(currentIndex + direction + buttons.length) % buttons.length].focus();
}

function mountSettingsView(container: HTMLElement) {
  onSoundEnabledChange(syncSoundEnabledValue);
  rootEl = container;
  rootEl.textContent = '';
  shellEl = el('div', 'settings-view-shell');
  const sidebar = el('div', 'settings-view-sidebar');
  searchEl = el('input', 'settings-view-search');
  searchEl.type = 'search';
  searchEl.placeholder = 'Search settings';
  searchEl.setAttribute('aria-label', 'Search settings');
  navigationEl = el('nav', 'settings-view-nav');
  navigationEl.setAttribute('role', 'navigation');
  navigationEl.setAttribute('aria-label', 'Settings sections');
  backButtonEl = el('button', 'settings-view-back', 'Settings');
  backButtonEl.prepend(createLineIcon(BACK_ICON_PATH));
  backButtonEl.type = 'button';
  backButtonEl.hidden = true;
  backButtonEl.setAttribute('aria-label', 'Back to settings sections');
  backButtonEl.addEventListener('click', returnToSettingsList);
  const content = el('div', 'settings-view-content');
  content.setAttribute('aria-live', 'polite');
  setContentEl(content);
  searchEl.addEventListener('input', () => {
    const currentSearchEl = searchEl;
    if (!currentSearchEl) return;
    setSearchQuery(currentSearchEl.value);
  });
  searchEl.addEventListener('keydown', handleNavigationKeydown);
  navigationEl.addEventListener('keydown', handleNavigationKeydown);
  sidebar.append(searchEl, backButtonEl, navigationEl);
  shellEl.append(sidebar, content);
  rootEl.appendChild(shellEl);
  setSettingsPayload(settingsPayloadSnapshot());
  syncSettingsViewMapToBuild();
  hydrate(settingsPayload);
  setPhoneSettingsScreenProbe(currentPhoneSettingsScreen);
  subscribeSettings(applySettingsChange);
  renderNavigation();
  reloadCustomSounds();
  settingsViewVisibilityObserver?.disconnect();
  settingsViewVisibilityObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) reloadCustomSounds();
  });
  settingsViewVisibilityObserver.observe(rootEl);
  activatePendingSection();
}

function reloadCustomSounds() {
  void loadCustomSounds().then(refreshSoundOptions);
}

function isAlertSoundPage(page: SettingsSection) {
  return pageSettings(page).some((setting) => setting.path === 'pref:soundId');
}

function refreshSoundOptions() {
  rebuildSettingsViewMap();
  storedValues['pref:soundId'] = resolveSoundId(getSoundId());
  if (searchQuery) {
    renderSearchContent();
    return;
  }
  const setting = settingById('alert-sound');
  if (setting && isAlertSoundPage(selectedPage)) refreshRow(setting);
}

function activateSection(sectionId: string | null, settingId: string | null, hashAtRequest: string) {
  const search = parseSettingsSearchHash(sectionId ?? hashAtRequest);
  if (search) {
    setSearchQuery(search.query);
    return;
  }
  setSearchQuery('', { updateHash: false });
  if (isPhoneLayout() && !sectionId) {
    history.replaceState(history.state, '', settingsSearchHash(''));
    return;
  }
  selectSection(sectionId || selectedPage.id, { settingId });
}

function activateLinkedSection(linkHash: string) {
  const target = parseSettingsHash(linkHash, viewMap, SETTINGS_SECTION_ALIASES, SETTINGS_MOVED_SETTINGS);
  activateSection(target?.sectionId ?? null, target?.settingId ?? null, linkHash);
}

function activatePendingSection() {
  const activation = takePendingSettingsActivation();
  if (!activation) return;
  if (activation.isLink) {
    activateLinkedSection(activation.hashAtRequest);
    return;
  }
  activateSection(activation.sectionId, activation.settingId, activation.hashAtRequest);
}

function showBroadcastSettings() {
  setSettingsPayload(settingsPayloadSnapshot());
  const isViewMapRebuilt = syncSettingsViewMapToBuild();
  hydrate(settingsPayload);
  if (searchQuery) {
    renderSearchContent();
    return;
  }
  if (isViewMapRebuilt) {
    renderNavigation();
    renderContent();
    return;
  }
  refreshVisibleRows();
}

function refreshUpdateRows() {
  if (selectedPage.id !== UPDATES_SECTION_ID) return;
  const setting = settingById('update-actions');
  if (setting) refreshReadout(setting);
}

function applySettingsChange(change: SettingsChange) {
  switch (change.kind) {
    case 'broadcast':
      showBroadcastSettings();
      return;
    case 'status':
      refreshSettingsStatus();
      return;
    case 'update':
      refreshUpdateRows();
      if (change.frame === 'status' && isAutoUpdateCheckAwaitingStatus && selectedPage.id === UPDATES_SECTION_ID) checkUpdatesIfStale();
      return;
    case 'activate':
      activatePendingSection();
      return;
    case 'return-to-list':
      returnToList();
  }
}

function refreshFlyingAnimalsAvailability() {
  if (selectedPage.id !== APPEARANCE_PAGE_ID) return;
  renderContent();
}

window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', refreshFlyingAnimalsAvailability);
onLayoutChange(() => {
  phoneSectionId = null;
  syncPhoneSettingsScreen();
  refreshFlyingAnimalsAvailability();
});

onAgentLoginsChanged(refreshSettingsStatus);

function refreshShortcutGroups() {
  const shortcutGroups = contentEl?.querySelector<HTMLElement>('.settings-view-shortcuts');
  if (shortcutGroups) renderShortcutGroups(shortcutGroups);
}

setPanelRefresher({ refreshRow, refreshRowFoot, refreshSettingsStatus, refreshShortcutGroups });

const view: ViewModule<HTMLElement> = { mount: mountSettingsView };

export { view };
