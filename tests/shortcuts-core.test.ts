import test from 'node:test';
import assert from 'node:assert/strict';

import type { ShortcutKeyEvent, ShortcutPlatform } from '../public/shortcuts-core.ts';
import { railAriaKeyShortcuts, resolveDashboardShortcut, shortcutGroupsFor, shortcutHint, shortcutPlatformFor } from '../public/shortcuts-core.ts';

const MAC_COMMAND = String.fromCharCode(0x2318);
const PLATFORMS: readonly ShortcutPlatform[] = ['mac', 'other'];

function keyEvent(code: string, modifiers: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return { code, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers };
}

function shortcutModifierHeld(platform: ShortcutPlatform): Partial<ShortcutKeyEvent> {
  return platform === 'mac' ? { metaKey: true } : { altKey: true };
}

function everyCaption(platform: ShortcutPlatform): string[] {
  const captions: string[] = [];
  for (const group of shortcutGroupsFor(platform)) {
    captions.push(group.title);
    for (const item of group.items) {
      captions.push(item.label);
      for (const chord of item.combos) captions.push(...chord);
    }
  }
  return captions;
}

test('a Mac user agent selects the Command scheme and anything else selects Alt', () => {
  assert.equal(shortcutPlatformFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'), 'mac');
  assert.equal(shortcutPlatformFor('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'), 'other');
  assert.equal(shortcutPlatformFor('Mozilla/5.0 (X11; Linux x86_64)'), 'other');
});

test('each dashboard action resolves from its physical key under the platform modifier', () => {
  for (const platform of PLATFORMS) {
    const held = shortcutModifierHeld(platform);
    assert.deepEqual(resolveDashboardShortcut(keyEvent('KeyJ', held), platform), { action: 'next-attention', step: 0 });
    assert.deepEqual(resolveDashboardShortcut(keyEvent('ArrowUp', held), platform), { action: 'rail-step', step: -1 });
    assert.deepEqual(resolveDashboardShortcut(keyEvent('ArrowDown', held), platform), { action: 'rail-step', step: 1 });
    assert.deepEqual(resolveDashboardShortcut(keyEvent('Digit1', held), platform), { action: 'session-nth', step: 1 });
    assert.deepEqual(resolveDashboardShortcut(keyEvent('Digit9', held), platform), { action: 'session-nth', step: 9 });
    assert.deepEqual(resolveDashboardShortcut(keyEvent('Digit0', held), platform), { action: 'new-session', step: 0 });
    assert.deepEqual(resolveDashboardShortcut(keyEvent('KeyI', held), platform), { action: 'merge', step: 0 });
    assert.deepEqual(resolveDashboardShortcut(keyEvent('KeyU', held), platform), { action: 'resolve-or-resync', step: 0 });
  }
});

test('Option on a Mac never fires a shortcut, so Option-typed characters reach the terminal', () => {
  for (const code of ['KeyJ', 'KeyI', 'KeyU', 'Digit5', 'Digit7', 'ArrowDown']) {
    assert.equal(resolveDashboardShortcut(keyEvent(code, { altKey: true }), 'mac'), null, code);
  }
});

test('Ctrl, Shift, or a second modifier leaves the key to the terminal, so no shortcut needs three keys', () => {
  for (const platform of PLATFORMS) {
    const held = shortcutModifierHeld(platform);
    assert.equal(resolveDashboardShortcut(keyEvent('KeyJ', { ...held, shiftKey: true }), platform), null);
    assert.equal(resolveDashboardShortcut(keyEvent('KeyJ', { ...held, ctrlKey: true }), platform), null);
    assert.equal(resolveDashboardShortcut(keyEvent('KeyJ', { altKey: true, metaKey: true }), platform), null);
    assert.equal(resolveDashboardShortcut(keyEvent('KeyJ'), platform), null);
  }
});

test('keys Claude Code binds under Alt stay with the terminal', () => {
  for (const code of ['KeyB', 'KeyD', 'KeyF', 'KeyM', 'KeyO', 'KeyP', 'KeyT', 'KeyV', 'KeyY', 'KeyW', 'KeyR', 'Enter', 'ArrowLeft', 'ArrowRight']) {
    assert.equal(resolveDashboardShortcut(keyEvent(code, { altKey: true }), 'other'), null, code);
  }
});

test('hints and help chords name the platform modifier', () => {
  assert.equal(shortcutHint('merge', 'mac'), `${MAC_COMMAND}I`);
  assert.equal(shortcutHint('merge', 'other'), 'Alt+I');
  assert.equal(shortcutHint('next-attention', 'other'), 'Alt+J');
  assert.equal(railAriaKeyShortcuts('mac'), 'ArrowUp ArrowDown Meta+ArrowUp Meta+ArrowDown');
  assert.equal(railAriaKeyShortcuts('other'), 'ArrowUp ArrowDown Alt+ArrowUp Alt+ArrowDown');
  const dashboardChords = shortcutGroupsFor('mac')[0].items.flatMap((item) => item.combos.map((chord) => chord.join('+')));
  assert.ok(dashboardChords.includes(`${MAC_COMMAND}+J`));
  assert.ok(dashboardChords.every((chord) => chord.startsWith(`${MAC_COMMAND}+`)));
  const macChords = shortcutGroupsFor('mac').flatMap((group) => group.items.flatMap((item) => item.combos.map((chord) => chord.join('+'))));
  assert.ok(macChords.includes(`${MAC_COMMAND}+C`) && !macChords.includes('Ctrl+C'));
});

test('every help group, item and chord carries renderable text', () => {
  for (const platform of PLATFORMS) {
    for (const group of shortcutGroupsFor(platform)) {
      assert.ok(group.title.length > 0);
      assert.ok(group.items.length > 0, `group ${group.title} has items`);
      for (const item of group.items) {
        assert.ok(item.label.length > 0);
        assert.ok(item.combos.length > 0);
        for (const chord of item.combos) {
          assert.ok(chord.length > 0 && chord.length <= 2, `chord ${chord.join('+')} is one or two keys`);
          for (const caption of chord) assert.ok(caption.length > 0);
        }
      }
    }
  }
});

test('help captions carry no banned dash or ellipsis literals', () => {
  const banned = [0x2014, 0x2013, 0x2026].map((code) => String.fromCharCode(code));
  for (const platform of PLATFORMS) {
    for (const caption of everyCaption(platform)) {
      for (const glyph of banned) assert.ok(!caption.includes(glyph), `"${caption}" must not contain a banned glyph`);
    }
  }
});
