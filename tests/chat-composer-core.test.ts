import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentModelCatalog, AgentSetup } from '../shared/contracts/agent-models.ts';
import {
  INITIAL_COMPOSER_STATE,
  MAX_INPUT_HEIGHT_PX,
  addComposerAttachment,
  applyComposerDraftText,
  carriesFileTransferTypes,
  composerSlotStateOf,
  computeFittedInputHeightPx,
  decideComposerKeydown,
  decideComposerSubmit,
  removeComposerAttachment,
  setComposerDropReady,
  shouldAttachPastedFiles,
} from '../public/chat/composer-core.ts';
import {
  CLOSED_MODEL_PICKER_STATE,
  applyModelPickerQuery,
  decideModelFindKeydown,
  decideModelPickerPanelKeydown,
  modelPickerDisplayOf,
  modelPickerRowsOf,
  openModelPickerState,
  pickEffortChoice,
  pickListedModel,
  pickTypedModel,
  selectModelPickerStep,
} from '../public/chat/model-picker-core.ts';
import { railGroupsOf, railModelDisplayOf } from '../public/chat/status-rail-core.ts';
import type { RailField } from '../public/chat/status-rail-core.ts';

const SAMPLE_CATALOG: AgentModelCatalog = {
  agents: [
    {
      agent: 'claude-code',
      configuredDefault: { model: 'claude-sonnet-4-5', effort: 'medium' },
      error: null,
      checkedAt: 0,
      models: [
        {
          id: 'claude-sonnet-4-5',
          label: 'Sonnet 4.5',
          aliases: [],
          isDefault: true,
          options: [{ id: 'effort', label: 'Effort', choices: ['low', 'medium', 'high'], defaultChoice: 'medium' }],
        },
        {
          id: 'claude-haiku-4-5',
          label: 'Haiku 4.5',
          aliases: [],
          isDefault: false,
          options: [],
        },
      ],
    },
  ],
  openrouter: {
    error: null,
    checkedAt: 0,
    models: [
      { id: 'anthropic/claude-sonnet-4-5', label: 'Sonnet 4.5 OR', aliases: [], isDefault: false, options: [] },
    ],
  },
};

const RUNNING_SETUP: AgentSetup = {
  agent: 'claude-code',
  provider: 'native',
  model: 'claude-sonnet-4-5',
  options: [{ id: 'effort', value: 'medium' }],
  instructions: '',
};

test('composer-core handles Enter, Shift+Enter, IME composition, and Escape decisions', () => {
  assert.equal(decideComposerKeydown({ key: 'Enter', shiftKey: false, isComposing: false }), 'submit');
  assert.equal(decideComposerKeydown({ key: 'Enter', shiftKey: true, isComposing: false }), 'none');
  assert.equal(decideComposerKeydown({ key: 'Enter', shiftKey: false, isComposing: true }), 'none');
  assert.equal(decideComposerKeydown({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 }), 'none');
  assert.equal(decideComposerKeydown({ key: 'Process', shiftKey: false, isComposing: false }), 'none');
  assert.equal(decideComposerKeydown({ key: 'Escape', shiftKey: false, isComposing: false }), 'escape');
});

test('composer-core manages draft, deduplicated attachments, submit clearing, and send-vs-stop slot state', () => {
  const emptyRunning = composerSlotStateOf(INITIAL_COMPOSER_STATE, true);
  assert.equal(emptyRunning.hasDraft, false);
  assert.equal(emptyRunning.isSendDisabled, true);
  assert.equal(emptyRunning.isStopDisabled, false);
  assert.equal(emptyRunning.dataTurnRunning, 'true');

  let state = applyComposerDraftText(INITIAL_COMPOSER_STATE, '   ');
  assert.equal(composerSlotStateOf(state, false).isSendDisabled, true);
  assert.equal(decideComposerSubmit(state, '   ').shouldSubmit, false);

  state = addComposerAttachment(addComposerAttachment(state, 'shot.png'), 'shot.png');
  assert.deepEqual(state.attachedFileNames, ['shot.png']);
  assert.equal(composerSlotStateOf(state, true).isSendDisabled, false);
  assert.equal(composerSlotStateOf(state, true).dataHasDraft, 'true');

  const submitted = decideComposerSubmit(applyComposerDraftText(state, '  hi  '), '  hi  ');
  assert.equal(submitted.shouldSubmit, true);
  if (submitted.shouldSubmit) {
    assert.equal(submitted.text, 'hi');
    assert.deepEqual(submitted.attachments, ['shot.png']);
    assert.equal(submitted.state.hasText, false);
    assert.deepEqual(submitted.state.attachedFileNames, []);
  }

  const afterRemove = removeComposerAttachment(state, 'shot.png');
  assert.deepEqual(afterRemove.attachedFileNames, []);
  assert.equal(shouldAttachPastedFiles(1, ''), true);
  assert.equal(shouldAttachPastedFiles(1, 'text'), false);
  assert.equal(carriesFileTransferTypes(['text/plain', 'Files']), true);
  assert.equal(computeFittedInputHeightPx('', true, 120), null);
  assert.equal(computeFittedInputHeightPx('a', false, 120), null);
  assert.equal(computeFittedInputHeightPx('a\nb', true, 400), MAX_INPUT_HEIGHT_PX);
  assert.equal(setComposerDropReady(INITIAL_COMPOSER_STATE, true).isDropReady, true);
});

test('model-picker-core steps through models and efforts, filters queries, and suppresses no-op switches', () => {
  const opened = openModelPickerState(SAMPLE_CATALOG, RUNNING_SETUP);
  assert.equal(modelPickerDisplayOf(opened).slot, 'model');
  assert.equal(modelPickerDisplayOf(opened).showsEffort, true);

  const pickedWithEfforts = pickListedModel(opened, 'native', 'claude-sonnet-4-5');
  assert.equal(pickedWithEfforts.outcome, 'step-effort');
  assert.equal(pickedWithEfforts.state.isOpen, true);
  if (pickedWithEfforts.state.isOpen) {
    assert.equal(modelPickerDisplayOf(pickedWithEfforts.state).slot, 'effort');
    const effortRows = modelPickerRowsOf(pickedWithEfforts.state);
    assert.equal(effortRows[0]?.kind, 'back');
    assert.equal(effortRows[1]?.kind, 'effort');

    const sameEffortCommit = pickEffortChoice(pickedWithEfforts.state, 'medium');
    assert.equal(sameEffortCommit.outcome, 'commit');
    assert.equal(sameEffortCommit.switchSetup, null);

    const changedEffortCommit = pickEffortChoice(pickedWithEfforts.state, 'high');
    assert.equal(changedEffortCommit.outcome, 'commit');
    assert.deepEqual(changedEffortCommit.switchSetup?.options, [{ id: 'effort', value: 'high' }]);

    const backToModels = selectModelPickerStep(pickedWithEfforts.state, 'models');
    assert.equal(backToModels.focusTarget, 'find');
    assert.equal(backToModels.state.step, 'models');
  }

  const pickedNoEfforts = pickListedModel(opened, 'native', 'claude-haiku-4-5');
  assert.equal(pickedNoEfforts.outcome, 'commit');
  assert.equal(pickedNoEfforts.switchSetup?.model, 'claude-haiku-4-5');

  const typedQueryState = applyModelPickerQuery(opened, 'custom-model-1');
  const findDecision = decideModelFindKeydown(typedQueryState, 'Enter');
  assert.deepEqual(findDecision, { kind: 'pick-typed', provider: 'native', modelId: 'custom-model-1' });
  const typedCommit = pickTypedModel(typedQueryState, 'native', 'custom-model-1');
  assert.equal(typedCommit.outcome, 'commit');
  assert.equal(typedCommit.switchSetup?.model, 'custom-model-1');
  const nonOpenRouterSetup: AgentSetup = { agent: 'antigravity', provider: 'native', model: 'gemini-2.5-pro', options: [], instructions: '' };
  const nonOpenRouterTyped = applyModelPickerQuery(openModelPickerState(SAMPLE_CATALOG, nonOpenRouterSetup), 'anthropic/claude-sonnet-4-5');
  assert.deepEqual(decideModelFindKeydown(nonOpenRouterTyped, 'Enter'), { kind: 'pick-typed', provider: 'native', modelId: 'anthropic/claude-sonnet-4-5' });

  assert.equal(decideModelPickerPanelKeydown('Escape'), 'close-with-focus');
  assert.equal(CLOSED_MODEL_PICKER_STATE.isOpen, false);
});

test('status-rail-core groups reading fields in limits-then-work order and derives model display', () => {
  const fields: RailField[] = [
    { kind: 'model', name: 'Sonnet 4.5', effort: 'high', canChange: true, agent: 'claude-code' },
    { kind: 'sessionCost', usd: 1.5 },
    { kind: 'plan', label: '5h', pct: 82, resetsInMs: null },
    { kind: 'permission', mode: 'plan mode' },
  ];
  const modelDisplay = railModelDisplayOf(fields);
  assert.equal(modelDisplay.isShown, true);
  assert.equal(modelDisplay.text, 'Sonnet 4.5 high');
  assert.equal(modelDisplay.ariaLabel, 'Change model, Sonnet 4.5 high');
  assert.equal(modelDisplay.canChange, true);

  const groups = railGroupsOf(fields);
  assert.deepEqual(groups.map((section) => section.group), ['limits', 'work']);
  assert.equal(groups[0]?.fields[0]?.level, 'hot');
  assert.deepEqual(groups[1]?.fields.map((field) => field.kind), ['sessionCost', 'permission']);
  assert.equal(railModelDisplayOf([]).isShown, false);
});
