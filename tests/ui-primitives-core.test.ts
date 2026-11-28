import './helpers/isolate-home.ts';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buttonDescriptor,
  isIconButtonVariant,
  isToggledOutlineState,
  linkButtonDescriptor,
  outlineIconStateAttributes,
} from '../public/ui/button-core.ts';
import { choiceDescriptor } from '../public/ui/checkbox-core.ts';
import { DEFAULT_COPY_CLEAR_AFTER_MS, copyButtonDescriptor, copyStatusText } from '../public/ui/copy-button-core.ts';
import {
  confirmDialogProps,
  dialogCloseOutcome,
  dialogConfirmPressOutcome,
  dialogDescriptor,
  isDialogBackdropClick,
} from '../public/ui/dialog-core.ts';
import { detailsBlockDescriptor, disclosureDescriptor } from '../public/ui/disclosure-core.ts';
import { emptyStateDescriptor } from '../public/ui/empty-state-core.ts';
import { fieldDescriptor, fieldMessageState, isLabelableTagName } from '../public/ui/field-core.ts';
import { keyChordParts, keycapDescriptor } from '../public/ui/keycap-core.ts';
import { clampMeterFraction, meterDescriptor, meterValueState } from '../public/ui/meter-core.ts';
import { noticeDescriptor, noticeMetaState, noticeShownPayload } from '../public/ui/notice-core.ts';
import { iconPressableLabel, pressableAttributes } from '../public/ui/pressable-core.ts';
import {
  findTypeaheadIndex,
  isMenuArrowKey,
  isMenuJumpKey,
  isTypeaheadKey,
  menuItemDescriptor,
  nextMenuItemIndex,
  nextTypeaheadQuery,
  popupMenuStateAttributes,
} from '../public/ui/popup-menu-core.ts';
import { sectionHeadingCountState, sectionHeadingDescriptor } from '../public/ui/section-heading-core.ts';
import { nextSegmentedValue, segmentedDescriptor, segmentedOptionStates } from '../public/ui/segmented-core.ts';
import { findSelectChoice, resolveSelectSelection, selectDescriptor } from '../public/ui/select-core.ts';
import { switchDescriptor } from '../public/ui/switch-core.ts';
import { tagDescriptor } from '../public/ui/tag-core.ts';
import { textAreaDescriptor, textInputDescriptor } from '../public/ui/text-input-core.ts';

describe('pressable-core', () => {
  test('always produces button type and preserves optional text', () => {
    assert.deepEqual(pressableAttributes('ui-row'), { type: 'button', className: 'ui-row' });
    assert.deepEqual(pressableAttributes('ui-row', 'Open'), { type: 'button', className: 'ui-row', text: 'Open' });
  });

  test('appends shortcut key to icon pressable title without altering aria-label', () => {
    assert.deepEqual(iconPressableLabel('Zoom in'), { ariaLabel: 'Zoom in', title: 'Zoom in' });
    assert.deepEqual(iconPressableLabel('Zoom in', '+'), { ariaLabel: 'Zoom in', title: 'Zoom in (+)' });
  });
});

describe('button-core', () => {
  test('routes label to aria-label for icon variants and visibleLabel for labelled variants', () => {
    assert.equal(isIconButtonVariant('icon'), true);
    assert.equal(isIconButtonVariant('primary'), false);

    const labelled = buttonDescriptor({ variant: 'primary', label: 'Save', textCase: 'upper', shortcutKey: 'S' });
    assert.equal(labelled.visibleLabel, 'Save');
    assert.equal(labelled.ariaLabel, undefined);
    assert.equal(labelled.textCase, undefined);
    assert.equal(labelled.ariaKeyShortcuts, 'S');
    assert.equal(labelled.size, 'default');

    const iconOnly = buttonDescriptor({ variant: 'floating-icon', label: 'Close', size: 'small', textCase: 'sentence', action: 'close', disabled: true, hidden: true });
    assert.equal(iconOnly.ariaLabel, 'Close');
    assert.equal(iconOnly.visibleLabel, undefined);
    assert.equal(iconOnly.textCase, 'sentence');
    assert.equal(iconOnly.action, 'close');
    assert.equal(iconOnly.disabled, true);
    assert.equal(iconOnly.hidden, true);
  });

  test('linkButtonDescriptor defaults size and enforces external link attributes', () => {
    assert.deepEqual(linkButtonDescriptor({ variant: 'secondary', label: 'Docs', href: 'https://example.com' }), {
      className: 'ui-button',
      variant: 'secondary',
      size: 'default',
      label: 'Docs',
      href: 'https://example.com',
      target: '_blank',
      rel: 'noopener',
    });
  });

  test('outlineIconStateAttributes rejects undeclared states and emits aria-pressed only for toggle sets', () => {
    assert.equal(isToggledOutlineState('pressed'), true);
    assert.equal(isToggledOutlineState('attention'), false);
    assert.equal(outlineIconStateAttributes(['idle', 'attention'], 'pressed'), null);
    assert.deepEqual(outlineIconStateAttributes(['idle', 'attention'], 'attention'), { outlineState: 'attention' });
    assert.deepEqual(outlineIconStateAttributes(['idle', 'pressed'], 'idle'), { outlineState: 'idle', ariaPressed: 'false' });
    assert.deepEqual(outlineIconStateAttributes(['idle', 'off'], 'off'), { outlineState: 'off', ariaPressed: 'true' });
  });
});

describe('text-input-core', () => {
  test('opts non-password inputs out of credential autofill and keeps password opt-out off', () => {
    const standard = textInputDescriptor({ placeholder: 'Search' });
    assert.equal(standard.type, 'text');
    assert.equal(standard.size, 'default');
    assert.equal(standard.isCredentialOptOut, true);
    assert.equal(standard.spellcheck, false);

    const password = textInputDescriptor({ type: 'password', size: 'small', spellcheck: true, disabled: true });
    assert.equal(password.isCredentialOptOut, false);
    assert.equal(password.autocomplete, 'off');
    assert.equal(password.spellcheck, true);
    assert.equal(password.disabled, true);
  });

  test('textAreaDescriptor defaults rows to 3 and leaves spellcheck unset unless passed', () => {
    const defaults = textAreaDescriptor();
    assert.equal(defaults.rows, 3);
    assert.equal(defaults.spellcheck, undefined);
    const custom = textAreaDescriptor({ rows: 6, spellcheck: false, label: 'Notes' });
    assert.equal(custom.rows, 6);
    assert.equal(custom.spellcheck, false);
    assert.equal(custom.ariaLabel, 'Notes');
  });
});

describe('field-core', () => {
  test('uses label[for] for labelable targets and preserves existing ids and describedby', () => {
    assert.equal(isLabelableTagName('input'), true);
    assert.equal(isLabelableTagName('div'), false);
    assert.deepEqual(fieldMessageState(''), { text: '', hidden: true });

    const generated = fieldDescriptor({
      idPrefix: 'ui-field-1',
      label: 'Host',
      isTargetLabelable: true,
      targetId: '',
      targetHasRole: false,
      existingDescribedBy: 'ext-help',
      hint: 'Hostname',
      error: 'Required',
    });
    assert.equal(generated.labelTag, 'label');
    assert.equal(generated.labelFor, 'ui-field-1-control');
    assert.equal(generated.assignedTargetId, 'ui-field-1-control');
    assert.equal(generated.describedIsWrapper, false);
    assert.equal(generated.ariaDescribedBy, 'ext-help ui-field-1-hint ui-field-1-error');
    assert.equal(generated.ariaInvalid, 'true');
  });

  test('falls back to group role on wrapper for non-labelable controls without role', () => {
    const grouped = fieldDescriptor({
      idPrefix: 'ui-field-2',
      label: 'Mode',
      isTargetLabelable: false,
      targetId: '',
      targetHasRole: false,
      existingDescribedBy: null,
      layout: 'inline',
    });
    assert.equal(grouped.labelTag, 'span');
    assert.equal(grouped.describedIsWrapper, true);
    assert.equal(grouped.wrapperRole, 'group');
    assert.equal(grouped.ariaLabelledBy, 'ui-field-2-label');
    assert.equal(grouped.hintHidden, true);

    const roled = fieldDescriptor({
      idPrefix: 'ui-field-3',
      label: 'Mode',
      isTargetLabelable: false,
      targetId: '',
      targetHasRole: true,
      existingDescribedBy: null,
    });
    assert.equal(roled.describedIsWrapper, false);
    assert.equal(roled.wrapperRole, undefined);
    assert.equal(roled.ariaLabelledBy, 'ui-field-3-label');
  });
});

describe('checkbox-core', () => {
  test('wires hint id to aria-describedby only when hint text is present', () => {
    const plain = choiceDescriptor({ type: 'checkbox' });
    assert.equal(plain.checked, false);
    assert.equal(plain.disabled, false);
    assert.equal(plain.ariaDescribedBy, undefined);
    assert.equal(plain.hintId, undefined);

    const withHint = choiceDescriptor({
      type: 'radio',
      name: 'mode',
      value: 'auto',
      checked: true,
      disabled: true,
      accessibleName: 'Automatic mode',
      hint: 'Applies immediately',
      hintId: 'ui-checkbox-hint-1',
    });
    assert.equal(withHint.name, 'mode');
    assert.equal(withHint.value, 'auto');
    assert.equal(withHint.ariaLabel, 'Automatic mode');
    assert.equal(withHint.hintId, 'ui-checkbox-hint-1');
    assert.equal(withHint.ariaDescribedBy, 'ui-checkbox-hint-1');
  });
});

describe('switch-core', () => {
  test('emits checkbox switch role with aria-label or aria-labelledby and defaults disabled false', () => {
    assert.deepEqual(switchDescriptor({ label: 'Sound', checked: true }), {
      className: 'ui-switch',
      type: 'checkbox',
      role: 'switch',
      ariaLabel: 'Sound',
      ariaLabelledBy: undefined,
      checked: true,
      disabled: false,
    });
    const byId = switchDescriptor({ labelledBy: 'sound-lbl', checked: false, disabled: true });
    assert.equal(byId.ariaLabel, undefined);
    assert.equal(byId.ariaLabelledBy, 'sound-lbl');
    assert.equal(byId.disabled, true);
  });
});

describe('select-core', () => {
  test('resolves matching, missing-first, and missing-blank selection modes', () => {
    const choices = [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
    ] as const;
    assert.deepEqual(resolveSelectSelection(choices, 'b'), { kind: 'value', value: 'b' });
    assert.deepEqual(resolveSelectSelection(choices, 'missing' as 'a', 'first'), { kind: 'default' });
    assert.deepEqual(resolveSelectSelection(choices, 'missing' as 'a', 'blank'), { kind: 'blank' });
    assert.deepEqual(resolveSelectSelection(choices, null, 'blank'), { kind: 'default' });
    assert.equal(findSelectChoice(choices, 'a')?.label, 'Alpha');
    assert.equal(findSelectChoice(choices, 'z'), undefined);

    const desc = selectDescriptor({ options: choices, value: 'b', size: 'small', id: 'theme-sel', label: 'Theme', disabled: true });
    assert.equal(desc.size, 'small');
    assert.equal(desc.id, 'theme-sel');
    assert.equal(desc.ariaLabel, 'Theme');
    assert.equal(desc.disabled, true);
    assert.deepEqual(desc.selection, { kind: 'value', value: 'b' });
  });
});

describe('segmented-core', () => {
  test('assigns roving tabindex and wraps arrow navigation across options', () => {
    const desc = segmentedDescriptor({ label: 'View', width: 'fill', size: 'small' });
    assert.equal(desc.role, 'radiogroup');
    assert.equal(desc.width, 'fill');
    assert.equal(desc.size, 'small');

    const states = segmentedOptionStates(['day', 'week', 'month'], 'week');
    assert.deepEqual(states, [
      { value: 'day', ariaChecked: 'false', tabIndex: -1 },
      { value: 'week', ariaChecked: 'true', tabIndex: 0 },
      { value: 'month', ariaChecked: 'false', tabIndex: -1 },
    ]);

    const fallbackStates = segmentedOptionStates(['day', 'week'], 'missing' as 'day');
    assert.equal(fallbackStates[0].tabIndex, 0);
    assert.equal(fallbackStates[0].ariaChecked, 'false');

    assert.equal(nextSegmentedValue(['day', 'week', 'month'], 'month', 'ArrowRight'), 'day');
    assert.equal(nextSegmentedValue(['day', 'week', 'month'], 'day', 'ArrowLeft'), 'month');
    assert.equal(nextSegmentedValue(['day', 'week', 'month'], 'day', 'Enter'), null);
    assert.equal(nextSegmentedValue([], 'day' as never, 'ArrowRight'), null);
  });
});

describe('disclosure-core', () => {
  test('defaults marker to plus and open to false, and defines detailsBlock summary', () => {
    assert.deepEqual(disclosureDescriptor(), {
      className: 'ui-disclosure',
      summaryClassName: 'ui-disclosure-summary',
      markerClassName: 'ui-disclosure-marker',
      bodyClassName: 'ui-disclosure-body',
      marker: 'plus',
      open: false,
    });
    const opened = disclosureDescriptor({ marker: 'chevron', open: true });
    assert.equal(opened.marker, 'chevron');
    assert.equal(opened.open, true);
    assert.deepEqual(detailsBlockDescriptor('stack trace'), {
      summary: 'Show details',
      bodyClassName: 'ui-details-block-text',
      text: 'stack trace',
    });
  });
});

describe('tag-core', () => {
  test('defaults tone to muted and shape to box while preserving overrides', () => {
    assert.deepEqual(tagDescriptor({ text: 'Beta' }), {
      className: 'ui-tag',
      text: 'Beta',
      tone: 'muted',
      shape: 'box',
    });
    assert.deepEqual(tagDescriptor({ text: 'Failed', tone: 'failed', shape: 'pill' }), {
      className: 'ui-tag',
      text: 'Failed',
      tone: 'failed',
      shape: 'pill',
    });
  });
});

describe('keycap-core', () => {
  test('omits data-tone for neutral keycaps and inserts plus separators between chord keys', () => {
    assert.deepEqual(keycapDescriptor('K'), { className: 'ui-keycap', text: 'K', tone: undefined });
    assert.deepEqual(keycapDescriptor('K', { tone: 'accent' }), { className: 'ui-keycap', text: 'K', tone: 'accent' });
    assert.deepEqual(keyChordParts([]), []);
    assert.deepEqual(keyChordParts(['Cmd', 'Shift', 'P']), [
      { kind: 'key', text: 'Cmd', className: 'ui-keycap' },
      { kind: 'sep', text: '+', className: 'ui-key-chord-sep' },
      { kind: 'key', text: 'Shift', className: 'ui-keycap' },
      { kind: 'sep', text: '+', className: 'ui-key-chord-sep' },
      { kind: 'key', text: 'P', className: 'ui-keycap' },
    ]);
  });
});

describe('meter-core', () => {
  test('clamps non-finite and out-of-range values and switches between decorative and ARIA meter modes', () => {
    assert.equal(clampMeterFraction(Number.NaN), 0);
    assert.equal(clampMeterFraction(-0.5), 0);
    assert.equal(clampMeterFraction(1.4), 1);

    const decorative = meterDescriptor({ value: 0.42 });
    assert.equal(decorative.ariaHidden, 'true');
    assert.equal(decorative.role, undefined);
    assert.equal(decorative.ariaValueNow, undefined);
    assert.equal(decorative.cssValue, '0.42');
    assert.equal(decorative.tone, 'accent');
    assert.equal(decorative.thickness, 'default');

    const labelled = meterDescriptor({ value: 0.756, label: 'Context', valueText: '76% used', tone: 'waiting', thickness: 'thick' });
    assert.equal(labelled.role, 'meter');
    assert.equal(labelled.ariaHidden, undefined);
    assert.equal(labelled.ariaLabel, 'Context');
    assert.equal(labelled.ariaValueMin, '0');
    assert.equal(labelled.ariaValueMax, '100');
    assert.equal(labelled.ariaValueNow, '76');
    assert.equal(labelled.ariaValueText, '76% used');
    assert.equal(meterValueState(0.5, 'Context', '').ariaValueText, undefined);
  });
});

describe('empty-state-core', () => {
  test('uses a paragraph root only when both title and actions are absent', () => {
    const textOnly = emptyStateDescriptor({ hasTitle: false, hasActions: false });
    assert.equal(textOnly.rootTag, 'p');
    assert.equal(textOnly.isTextOnly, true);
    assert.equal(textOnly.variant, 'inline');

    const withTitle = emptyStateDescriptor({ hasTitle: true, hasActions: false, variant: 'boxed' });
    assert.equal(withTitle.rootTag, 'div');
    assert.equal(withTitle.isTextOnly, false);
    assert.equal(withTitle.variant, 'boxed');

    const withActions = emptyStateDescriptor({ hasTitle: false, hasActions: true, variant: 'centered' });
    assert.equal(withActions.rootTag, 'div');
    assert.equal(withActions.isTextOnly, false);
  });
});

describe('section-heading-core', () => {
  test('maps heading level to tag and hides count only when null or empty string', () => {
    const h2 = sectionHeadingDescriptor({ level: 2, count: 4, tone: 'strong' });
    assert.equal(h2.titleTag, 'h2');
    assert.equal(h2.tone, 'strong');
    assert.deepEqual(h2.count, { text: '4', hidden: false });

    const none = sectionHeadingDescriptor({ level: 'none' });
    assert.equal(none.titleTag, 'div');
    assert.equal(none.tone, 'muted');
    assert.deepEqual(none.count, { text: '', hidden: true });
    assert.deepEqual(sectionHeadingCountState(0), { text: '0', hidden: false });
    assert.deepEqual(sectionHeadingCountState(''), { text: '', hidden: true });
  });
});

describe('copy-button-core', () => {
  test('defaults variant, size, label, clear delay, and status messages', () => {
    const defaults = copyButtonDescriptor();
    assert.equal(defaults.variant, 'secondary');
    assert.equal(defaults.size, 'default');
    assert.equal(defaults.label, 'Copy');
    assert.equal(defaults.clearAfterMs, DEFAULT_COPY_CLEAR_AFTER_MS);
    assert.equal(copyStatusText('copied'), 'Copied');
    assert.equal(copyStatusText('failed'), 'Copy failed');
  });
});

describe('notice-core', () => {
  test('derives hidden flags for unshown vs shown notices and builds the shown report payload', () => {
    const hiddenNotice = noticeDescriptor({
      id: 'update-notice',
      dismissLabel: 'Dismiss',
      isDismissIcon: true,
      shown: false,
      hasActions: false,
    });
    assert.equal(hiddenNotice.hidden, true);
    assert.equal(hiddenNotice.actionsHidden, false);
    assert.equal(hiddenNotice.commandHidden, false);
    assert.equal(hiddenNotice.metaHidden, false);
    assert.equal(hiddenNotice.dismissVariant, 'icon');

    const shownNotice = noticeDescriptor({
      id: 'update-notice',
      dismissLabel: 'Dismiss',
      isDismissIcon: false,
      shown: true,
      tone: 'warning',
      hasActions: true,
      command: 'npm i -g glimmervoid',
      meta: 'v0.67.0',
    });
    assert.equal(shownNotice.hidden, false);
    assert.equal(shownNotice.actionsHidden, false);
    assert.equal(shownNotice.commandHidden, false);
    assert.equal(shownNotice.metaHidden, false);
    assert.equal(shownNotice.dismissVariant, 'secondary');
    assert.deepEqual(noticeMetaState(''), { text: '', hidden: true });
    assert.deepEqual(noticeShownPayload({
      id: 'update-notice',
      message: 'Update ready',
      tone: 'warning',
      reported: { source: 'release' },
    }), {
      notice: 'update-notice',
      message: 'Update ready',
      tone: 'warning',
      source: 'release',
    });
  });
});

describe('dialog-core', () => {
  test('builds confirm dialog defaults and danger variant descriptors', () => {
    const defaultConfirm = dialogDescriptor(confirmDialogProps({
      title: 'Restart Server',
      message: 'Restart the server?',
    }));
    assert.deepEqual(defaultConfirm, {
      className: 'dialog',
      title: 'Restart Server',
      message: 'Restart the server?',
      cancelLabel: 'Cancel',
      confirmButton: { label: 'Confirm', variant: 'primary', action: 'confirm-dialog', disabled: false },
      canConfirm: true,
      closeOnConfirm: true,
      defaultAction: 'cancel',
      closeOnBackdrop: true,
      closeOnEscape: true,
    });

    const asyncConfirm = dialogDescriptor({
      title: 'Pick Orchestrator agent',
      confirmLabel: 'Start',
      canConfirm: false,
      closeOnConfirm: false,
      defaultAction: 'confirm',
    });
    assert.equal(asyncConfirm.confirmButton?.disabled, true);
    assert.equal(asyncConfirm.canConfirm, false);
    assert.equal(asyncConfirm.closeOnConfirm, false);
    assert.equal(asyncConfirm.defaultAction, 'cancel');

    assert.deepEqual(dialogConfirmPressOutcome(false, true), { shouldClose: false, shouldConfirm: false });
    assert.deepEqual(dialogConfirmPressOutcome(false, false), { shouldClose: false, shouldConfirm: false });
    assert.deepEqual(dialogConfirmPressOutcome(true, true), { shouldClose: true, shouldConfirm: true });
    assert.deepEqual(dialogConfirmPressOutcome(true, false), { shouldClose: false, shouldConfirm: true });

    const dangerConfirm = dialogDescriptor(confirmDialogProps({
      title: 'Delete board',
      message: 'Delete for good?',
      confirmLabel: 'Delete board',
      danger: true,
    }));
    assert.equal(dangerConfirm.confirmButton?.variant, 'danger');
    assert.equal(dangerConfirm.confirmButton?.label, 'Delete board');
    assert.equal(dangerConfirm.defaultAction, 'cancel');

    const cancelOnly = dialogDescriptor({ title: 'Info', dialogClass: 'custom-dialog', defaultAction: 'confirm' });
    assert.equal(cancelOnly.className, 'dialog custom-dialog');
    assert.equal(cancelOnly.confirmButton, null);
    assert.equal(cancelOnly.defaultAction, 'cancel');
  });

  test('classifies close reasons and detects backdrop clicks outside dialog bounds', () => {
    assert.deepEqual(dialogCloseOutcome('confirm'), { confirmed: true, dismissed: false });
    assert.deepEqual(dialogCloseOutcome('cancel'), { confirmed: false, dismissed: true });
    assert.deepEqual(dialogCloseOutcome('escape'), { confirmed: false, dismissed: true });
    assert.deepEqual(dialogCloseOutcome('backdrop'), { confirmed: false, dismissed: true });
    assert.deepEqual(dialogCloseOutcome('programmatic'), { confirmed: false, dismissed: true });

    const bounds = { left: 100, right: 520, top: 200, bottom: 380 };
    assert.equal(isDialogBackdropClick({ clientX: 250, clientY: 260 }, bounds), false);
    assert.equal(isDialogBackdropClick({ clientX: 100, clientY: 200 }, bounds), false);
    assert.equal(isDialogBackdropClick({ clientX: 99, clientY: 260 }, bounds), true);
    assert.equal(isDialogBackdropClick({ clientX: 250, clientY: 381 }, bounds), true);
    assert.equal(isDialogBackdropClick({ clientX: 10, clientY: 10 }, { left: 0, right: 0, top: 0, bottom: 0 }), false);
  });
});

describe('popup-menu-core', () => {
  test('builds menu item descriptors with tone and checkable role attributes', () => {
    assert.deepEqual(menuItemDescriptor({ label: 'Rename', className: 'overflow-rename' }), {
      className: 'popup-menu-item overflow-rename',
      role: 'menuitem',
      tone: null,
      label: 'Rename',
    });
    assert.deepEqual(menuItemDescriptor({ label: 'Remove', className: '', tone: 'danger' }), {
      className: 'popup-menu-item',
      role: 'menuitem',
      tone: 'danger',
      label: 'Remove',
    });
    assert.deepEqual(menuItemDescriptor({ label: 'Question manager', role: 'menuitemcheckbox', checked: true }), {
      className: 'popup-menu-item',
      role: 'menuitemcheckbox',
      tone: null,
      label: 'Question manager',
      ariaChecked: 'true',
    });
  });

  test('derives open and closed menu state attributes and keyboard navigation', () => {
    assert.deepEqual(popupMenuStateAttributes(false), { hidden: true, dataState: 'closed', ariaExpanded: 'false' });
    assert.deepEqual(popupMenuStateAttributes(true), { hidden: false, dataState: 'open', ariaExpanded: 'true' });

    assert.equal(isMenuArrowKey('ArrowDown'), true);
    assert.equal(isMenuArrowKey('ArrowLeft'), false);
    assert.equal(isMenuJumpKey('Home'), true);
    assert.equal(isMenuJumpKey('End'), true);
    assert.equal(isTypeaheadKey('r', false), true);
    assert.equal(isTypeaheadKey(' ', false), false);
    assert.equal(isTypeaheadKey('r', true), false);

    assert.equal(nextMenuItemIndex('ArrowDown', -1, 4), 0);
    assert.equal(nextMenuItemIndex('ArrowUp', -1, 4), 3);
    assert.equal(nextMenuItemIndex('ArrowDown', 3, 4), 0);
    assert.equal(nextMenuItemIndex('Home', 2, 4), 0);
    assert.equal(nextMenuItemIndex('End', 0, 4), 3);
    assert.equal(nextMenuItemIndex('Escape', 0, 4), null);
  });

  test('matches single-char cycling, multi-char prefix, and timeout reset for typeahead', () => {
    const labels = ['Rename', 'Restart', 'Remove', 'Snooze'];
    assert.equal(nextTypeaheadQuery('', 'R', 100), 'r');
    assert.equal(nextTypeaheadQuery('r', 'e', 120), 're');
    assert.equal(nextTypeaheadQuery('re', 's', 650), 's');

    assert.equal(findTypeaheadIndex(labels, 'r', -1), 0);
    assert.equal(findTypeaheadIndex(labels, 'r', 0), 1);
    assert.equal(findTypeaheadIndex(labels, 'rr', 1), 2);
    assert.equal(findTypeaheadIndex(labels, 'rem', 0), 2);
    assert.equal(findTypeaheadIndex(labels, 're', 1), 1);
    assert.equal(findTypeaheadIndex(labels, 's', 2), 3);
    assert.equal(findTypeaheadIndex(labels, 'z', 0), null);
  });
});
