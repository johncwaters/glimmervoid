import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SOUND_ID,
  TONES_BY_SOUND_ID,
  customSoundUrl,
  parseCustomSoundList,
  resolveSoundId,
  soundOptions,
} from '../public/alert-sound-core.ts';

test('the default sound is a generated built-in, and beep is kept', () => {
  assert.equal(Object.hasOwn(TONES_BY_SOUND_ID, DEFAULT_SOUND_ID), true);
  assert.equal(Object.hasOwn(TONES_BY_SOUND_ID, 'beep'), true);
});

test('a stored preference naming a removed sound falls back to the default', () => {
  assert.equal(resolveSoundId('coins', []), DEFAULT_SOUND_ID);
  assert.equal(resolveSoundId('tears', null), DEFAULT_SOUND_ID);
  assert.equal(resolveSoundId(undefined, null), DEFAULT_SOUND_ID);
  assert.equal(resolveSoundId('custom:', null), DEFAULT_SOUND_ID);
});

test('a built-in sound id resolves to itself', () => {
  assert.equal(resolveSoundId('beep', []), 'beep');
  assert.equal(resolveSoundId('ping', null), 'ping');
});

test('a custom sound resolves to itself while listed or while the list is unknown, and to the default once it is gone', () => {
  assert.equal(resolveSoundId('custom:alarm.ogg', ['alarm.ogg']), 'custom:alarm.ogg');
  assert.equal(resolveSoundId('custom:alarm.ogg', null), 'custom:alarm.ogg');
  assert.equal(resolveSoundId('custom:alarm.ogg', ['other.mp3']), DEFAULT_SOUND_ID);
});

test('custom sounds are listed after the built-ins', () => {
  const options = soundOptions(['alarm.ogg']);
  const builtInIds = Object.keys(TONES_BY_SOUND_ID);
  assert.deepEqual(options.map((option) => option.id), [...builtInIds, 'custom:alarm.ogg']);
  assert.deepEqual(options.at(-1), { id: 'custom:alarm.ogg', label: 'alarm.ogg' });
  assert.deepEqual(soundOptions(null).map((option) => option.id), builtInIds);
});

test('a custom sound url encodes the file name as one path segment', () => {
  assert.equal(customSoundUrl('my chime #2.ogg'), '/custom-sounds/my%20chime%20%232.ogg');
});

test('the custom sound list parser keeps only non-empty string names', () => {
  assert.deepEqual(parseCustomSoundList({ sounds: ['a.ogg', 3, '', 'b.mp3'] }), ['a.ogg', 'b.mp3']);
  assert.deepEqual(parseCustomSoundList({ sounds: 'a.ogg' }), []);
  assert.deepEqual(parseCustomSoundList(null), []);
});
