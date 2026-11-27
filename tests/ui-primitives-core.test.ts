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
import { fieldDescriptor, fieldMessageState, isLabelableTagName } from '../public/ui/field-core.ts';
import { iconPressableLabel, pressableAttributes } from '../public/ui/pressable-core.ts';
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
