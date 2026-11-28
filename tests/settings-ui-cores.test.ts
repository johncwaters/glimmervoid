import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { SETTINGS_REGISTRY } from '../shared/settings/registry.ts';
import {
  ACCOUNT_LINK_LABEL,
  IDLE_ACTION_FEEDBACK,
  INITIAL_WORKFLOW_RULES_UI_STATE,
  SAVED_STATUS_MS,
  TELEMETRY_DELETION_TIMEOUT_MS,
  TELEMETRY_SENT_DETAIL,
  accountLinkDisplayOf,
  agentVisibilityDisplayOf,
  beginActionFeedback,
  clearWorkflowRuleSaved,
  controlKindOf,
  customAgentLinesOf,
  decideDraftKeydown,
  decideFieldCommit,
  decidePasswordCommit,
  decideTelegramTestOutcome,
  decideTelemetryDeletionOutcome,
  decideToggleChange,
  listHintTextOf,
  markWorkflowRuleFailed,
  markWorkflowRulePending,
  markWorkflowRuleSaved,
  nextHiddenAgentIds,
  numberInputMetaOf,
  readoutKindOf,
  rowDisplayOf,
  statusSlotKindOf,
  telegramDeliveryLinesOf,
  textInputMetaOf,
  updateStatusDisplayOf,
  workflowRuleStatusOf,
} from '../public/settings/settings-view-core.ts';
import {
  ACCOUNT_AGENTS,
  CLOSED_RENAME_DIALOG,
  LANE_DESCRIPTIONS,
  LANE_TITLES,
  PLAN_VENDOR_BY_AGENT,
  accountSubText,
  agentAccountCardsOf,
  beginRenameSubmit,
  confirmAccountRemovalCopy,
  failRenameSubmit,
  laneAccountRowsOf,
  laneChoiceOf,
  openRenameDialogState,
} from '../public/settings/settings-accounts-core.ts';
import {
  aboutVersionTextOf,
  clearPhoneSectionTransition,
  createInitialSettingsPanelState,
  decideNavigationKeydown,
  expandAdvancedTransition,
  featureListRowsOf,
  highlightedSearchPartsOf,
  isAlertSoundPage,
  pageKindOf,
  searchResultsDisplayOf,
  selectSectionTransition,
  setFileOnlyOpenTransition,
  setSearchQueryTransition,
  toggleAdvancedTransition,
  toggleAnimalGalleryTransition,
  visibleSettingsSplitOf,
} from '../public/settings/settings-panel-core.ts';
import { IDLE_UPDATE_REQUEST } from '../public/updates-view-core.ts';

test('decideDraftKeydown guards IME composition on Enter and distinguishes multiline Shift+Enter', () => {
  assert.equal(decideDraftKeydown('Enter', false, true, 13, false), 'ignore');
  assert.equal(decideDraftKeydown('Enter', false, false, 229, false), 'ignore');
  assert.equal(decideDraftKeydown('Process', false, false, 229, false), 'ignore');
  assert.equal(decideDraftKeydown('Enter', false, false, 13, false), 'commit');
  assert.equal(decideDraftKeydown('Enter', true, false, 13, true), 'ignore');
  assert.equal(decideDraftKeydown('Enter', false, false, 13, true), 'commit');
  assert.equal(decideDraftKeydown('Escape', false, false, 27, false), 'restore');
});

test('rowDisplayOf, controlKindOf, and input meta helpers preserve registry contracts', () => {
  const section = SETTINGS_REGISTRY.sections.find((entry) => entry.settings.length > 0);
  assert.ok(section);
  const setting = section.settings[0];
  const row = rowDisplayOf(setting, section, setting.defaultValue, {}, undefined, undefined, false, false);
  assert.equal(row.canReset, false);
  assert.equal(row.isFootIdle, true);
  assert.ok(typeof controlKindOf(setting) === 'string');

  const numberSetting = SETTINGS_REGISTRY.sections.flatMap((entry) => entry.settings).find((entry) => entry.control === 'number');
  assert.ok(numberSetting);
  assert.ok(numberInputMetaOf(numberSetting).step.length > 0);

  const secretSetting = SETTINGS_REGISTRY.sections.flatMap((entry) => entry.settings).find((entry) => entry.control === 'password');
  assert.ok(secretSetting);
  const envMeta = textInputMetaOf(secretSetting, '', { secretSources: { [secretSetting.path]: 'ENV_VAR' } });
  assert.equal(envMeta.isDisabled, true);
  assert.equal(envMeta.ariaDescription, 'Supplied by ENV_VAR');
  assert.equal(decidePasswordCommit('').kind, 'ignore');
  assert.equal(decidePasswordCommit('secret').kind, 'commit');

  const listSetting = SETTINGS_REGISTRY.sections.flatMap((entry) => entry.settings).find((entry) => entry.control === 'list');
  assert.ok(listSetting);
  assert.ok(listHintTextOf(listSetting, []).includes('Shift+Enter'));

  const dangerToggle = SETTINGS_REGISTRY.sections.flatMap((entry) => entry.settings).find((entry) => entry.control === 'toggle' && entry.danger);
  assert.ok(dangerToggle);
  assert.equal(decideToggleChange(dangerToggle, true).kind, 'confirm-danger');
  assert.equal(decideToggleChange(dangerToggle, false).kind, 'commit');

  const fieldDecision = decideFieldCommit(
    SETTINGS_REGISTRY.sections,
    numberSetting,
    { base: numberSetting.defaultValue, isDirty: false },
    '123',
    {},
    '123',
    false,
  );
  assert.equal(fieldDecision.kind, 'unchanged');
});

test('agentVisibilityDisplayOf and nextHiddenAgentIds keep default agent locked and list missing agents', () => {
  const agents = [
    { id: 'claude-code', label: 'Claude Code', resolvable: true },
    { id: 'codex', label: 'Codex', resolvable: true },
    { id: 'kimi', label: 'Kimi', resolvable: false },
  ];
  const display = agentVisibilityDisplayOf('hidden-agents', ['codex'], 'loaded', agents, 'claude-code');
  assert.equal(display.items.length, 2);
  assert.equal(display.items[0]?.isDisabled, true);
  assert.equal(display.items[0]?.isChecked, true);
  assert.equal(display.items[1]?.isChecked, false);
  assert.equal(display.noteText, 'Not installed: Kimi.');
  assert.deepEqual(nextHiddenAgentIds(['codex'], 'codex', true), []);
  assert.deepEqual(nextHiddenAgentIds([], 'codex', false), ['codex']);
});

test('readout, workflow rule, telegram, telemetry, and update status cores produce deterministic displays', () => {
  assert.equal(SAVED_STATUS_MS, 2200);
  assert.equal(TELEMETRY_DELETION_TIMEOUT_MS, 15000);
  assert.ok(ACCOUNT_LINK_LABEL.length > 0 && TELEMETRY_SENT_DETAIL.length > 0);
  assert.equal(readoutKindOf('update-actions'), 'update-actions');
  assert.equal(readoutKindOf('unknown'), 'unavailable');
  const nonEmptySection = SETTINGS_REGISTRY.sections.find((entry) => entry.settings.length > 0);
  assert.ok(nonEmptySection);
  assert.equal(statusSlotKindOf(nonEmptySection.settings[0], {}).kind, 'none');
  assert.equal(IDLE_ACTION_FEEDBACK.isBusy, false);
  assert.deepEqual(customAgentLinesOf([]), ['None declared. Add customAgents to config.json.']);
  assert.deepEqual(customAgentLinesOf([{ id: 'bad', label: 'Bad', command: 'cli' }]), ['None declared. Add customAgents to config.json.']);
  assert.deepEqual(workflowRuleStatusOf(INITIAL_WORKFLOW_RULES_UI_STATE, 'constructor'), {
    isPending: false,
    tone: null,
    text: '',
  });

  let rulesState = markWorkflowRulePending(INITIAL_WORKFLOW_RULES_UI_STATE, 'r1');
  assert.equal(workflowRuleStatusOf(rulesState, 'r1').tone, 'busy');
  rulesState = markWorkflowRuleSaved(rulesState, 'r1');
  assert.equal(workflowRuleStatusOf(rulesState, 'r1').tone, 'ok');
  rulesState = clearWorkflowRuleSaved(rulesState, 'r1');
  assert.equal(workflowRuleStatusOf(rulesState, 'r1').tone, null);
  rulesState = markWorkflowRuleFailed(rulesState, 'r1', 'Refused');
  assert.equal(workflowRuleStatusOf(rulesState, 'r1').text, 'Refused');

  assert.deepEqual(telegramDeliveryLinesOf(null, (ts) => String(ts)), []);
  assert.equal(beginActionFeedback('Working').isBusy, true);
  assert.equal(decideTelegramTestOutcome(true, undefined).tone, 'ok');
  assert.equal(decideTelegramTestOutcome(false, 'bad').tone, 'error');
  assert.equal(decideTelemetryDeletionOutcome(true).tone, 'ok');
  assert.equal(decideTelemetryDeletionOutcome(false).tone, 'error');
  assert.equal(accountLinkDisplayOf(null, 'https://glimmervoid.dev/account', 'install').isDisabled, true);
  assert.equal(accountLinkDisplayOf('inst-1', 'https://glimmervoid.dev/account', 'install').href, 'https://glimmervoid.dev/account?install=inst-1');

  const updateDisplay = updateStatusDisplayOf(
    {
      status: { current: '0.66.0', updateAvailable: false },
      journal: null,
      request: IDLE_UPDATE_REQUEST,
      lastAutoCheckAt: null,
      isCheckInFlight: false,
      checkSendFailure: null,
    },
    true,
    'just now',
  );
  assert.equal(updateDisplay.headline, 'Up to date.');
  assert.equal(updateDisplay.actions[0]?.id, 'check');
});

test('settings-accounts-core builds cards, lane rows, and rename dialog transitions', () => {
  assert.equal(ACCOUNT_AGENTS.length, 2);
  assert.ok(LANE_TITLES['team-review'] && LANE_DESCRIPTIONS['team-review'] && PLAN_VENDOR_BY_AGENT.codex === 'codex');
  const stubAccount = {
    agent: 'claude-code' as const,
    accountId: 'acc-1',
    label: 'Work',
    isDefault: true,
    isPending: false,
    login: {
      state: 'signed-in' as const,
      verificationUrl: null,
      userCode: null,
      needsPastedCode: false,
      reason: null,
    },
    plan: 'Max',
    detail: 'stub-detail',
    usedBy: [],
    lanes: ['team-review' as const],
  };
  assert.equal(accountSubText(stubAccount), 'Max \u00b7 stub-detail');
  const cards = agentAccountCardsOf(
    { 'claude-code': [stubAccount], codex: [] },
    { 'claude-code': 'Claude Code', codex: 'Codex' },
    () => null,
    () => '#777',
  );
  assert.equal(cards[0]?.rows[0]?.isSignedIn, true);
  assert.equal(cards[0]?.rows[0]?.planMeters, null);
  assert.ok(confirmAccountRemovalCopy('Claude Code', stubAccount).title.includes('Work'));

  const laneRows = laneAccountRowsOf(['team-review'], [stubAccount], () => '#777');
  assert.equal(laneRows[0]?.chosenValue, 'account:acc-1');
  assert.equal(laneRows[0]?.billsText, 'Bills Max');
  assert.deepEqual(laneChoiceOf('default'), { followsDefault: true, accountId: null });
  assert.deepEqual(laneChoiceOf('machine'), { followsDefault: false, accountId: null });
  assert.deepEqual(laneChoiceOf('account:acc-1'), { followsDefault: false, accountId: 'acc-1' });

  let dialog = openRenameDialogState('acc-1', 'Work');
  dialog = beginRenameSubmit(dialog);
  assert.equal(dialog.isOpen && dialog.isSubmitting, true);
  dialog = failRenameSubmit(dialog, 'Duplicate name');
  assert.equal(dialog.isOpen ? dialog.errorText : '', 'Duplicate name');
  assert.equal(CLOSED_RENAME_DIALOG.isOpen, false);
});

test('settings-panel-core transitions navigation, search highlights, and page classification', () => {
  const sections = SETTINGS_REGISTRY.sections;
  let state = createInitialSettingsPanelState(sections[0].id);
  const selected = selectSectionTransition(state, sections, sections[1].id, {
    updateHash: true,
    openPhoneSection: true,
    isPhone: true,
  });
  state = selected.state;
  assert.equal(selected.isPageChange, true);
  assert.equal(state.phoneSectionId, sections[1].id);

  state = setSearchQueryTransition(state, '  theme ');
  assert.equal(state.searchQuery, 'theme');
  assert.equal(state.phoneSectionId, null);

  state = toggleAdvancedTransition(state);
  assert.equal(state.isAdvancedExpanded, true);
  state = expandAdvancedTransition(state);
  assert.equal(state.isAdvancedExpanded, true);
  state = toggleAnimalGalleryTransition(state);
  assert.equal(state.isAnimalGalleryExpanded, true);
  state = setFileOnlyOpenTransition(state, sections[0].id, true);
  assert.equal(state.fileOnlyOpenPageId, sections[0].id);
  state = clearPhoneSectionTransition(state);
  assert.equal(state.phoneSectionId, null);

  assert.equal(decideNavigationKeydown('Enter', true, 'theme', -1, 3, true).kind, 'ignore');
  assert.equal(decideNavigationKeydown('Enter', true, 'theme', -1, 3, false).kind, 'choose-first-search');
  assert.equal(decideNavigationKeydown('Escape', true, 'theme', -1, 3, false).kind, 'clear-search');
  assert.deepEqual(decideNavigationKeydown('ArrowUp', false, '', 0, 3, false), { kind: 'move-nav', nextIndex: 2 });

  const nonEmptySection = sections.find((entry) => entry.settings.length > 0);
  assert.ok(nonEmptySection);
  const searchResult = {
    section: nonEmptySection,
    setting: nonEmptySection.settings[0],
    score: 10,
    matches: [{ field: 'title' as const, text: nonEmptySection.settings[0].title, spans: [{ start: 0, end: 2 }] }],
  };
  const parts = highlightedSearchPartsOf(nonEmptySection.settings[0].title, searchResult, 'title');
  assert.equal(parts[0]?.isMatch, true);
  assert.equal(searchResultsDisplayOf(sections, [searchResult], {}).length, 1);
  assert.deepEqual(featureListRowsOf([], sections, () => null, () => false, {}, () => undefined), []);
  assert.equal(aboutVersionTextOf('0.66.0'), 'v0.66.0');
  assert.equal(aboutVersionTextOf(''), 'version unknown');
  assert.equal(
    pageKindOf('about', { shortcuts: 's', about: 'about', statusKey: 'k', features: 'f', hooks: 'h' }),
    'about',
  );
  assert.equal(visibleSettingsSplitOf(sections[0], {}, {}).regular.length >= 0, true);
  assert.equal(typeof isAlertSoundPage(sections[0]), 'boolean');
});
