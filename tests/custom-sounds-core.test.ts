import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  customSoundContentType,
  decideByteRange,
  isCustomSoundName,
  isDirectChildOf,
  resolveCustomSoundsDir,
  selectCustomSoundNames,
} from '../server/core/custom-sounds-core.ts';

test('each accepted audio extension maps to its content type, case-insensitively', () => {
  assert.equal(customSoundContentType('done.ogg'), 'audio/ogg');
  assert.equal(customSoundContentType('done.MP3'), 'audio/mpeg');
  assert.equal(customSoundContentType('done.wav'), 'audio/wav');
  assert.equal(customSoundContentType('done.m4a'), 'audio/mp4');
  assert.equal(customSoundContentType('done.webm'), 'audio/webm');
  assert.equal(customSoundContentType('my chime (v2).ogg'), 'audio/ogg');
});

test('names that are not a plain audio file basename are refused', () => {
  const refusedNames: unknown[] = [
    '',
    'notes.txt',
    'script.js',
    'index.html',
    'noextension',
    '.ogg',
    '.hidden.ogg',
    '../config.json',
    '../secret.ogg',
    '..',
    'nested/sound.ogg',
    'nested\\sound.ogg',
    'C:sound.ogg',
    'sound.ogg:stream',
    'bad\u0000name.ogg',
    'line\nbreak.ogg',
    `${'a'.repeat(252)}.ogg`,
    42,
    null,
  ];
  for (const name of refusedNames) assert.equal(isCustomSoundName(name), false, `expected ${JSON.stringify(name)} refused`);
});

test('listing keeps only regular audio files, sorted by name', () => {
  const names = selectCustomSoundNames([
    { name: 'zap.mp3', isFile: true },
    { name: 'alarm.ogg', isFile: true },
    { name: 'readme.txt', isFile: true },
    { name: '.DS_Store', isFile: true },
    { name: 'folder.ogg', isFile: false },
  ]);
  assert.deepEqual(names, ['alarm.ogg', 'zap.mp3']);
});

test('a resolved file must sit directly inside the resolved sounds directory', () => {
  const soundsDir = path.resolve('/home/op/.glimmervoid/sounds');
  assert.equal(isDirectChildOf(soundsDir, path.join(soundsDir, 'alarm.ogg')), true);
  assert.equal(isDirectChildOf(soundsDir, path.resolve('/etc/passwd')), false);
  assert.equal(isDirectChildOf(soundsDir, path.join(soundsDir, 'nested', 'alarm.ogg')), false);
  assert.equal(isDirectChildOf(soundsDir, path.resolve('/home/op/.glimmervoid/config.json')), false);
});

test('the sounds directory is the sounds folder of the glimmervoid home', () => {
  const home = path.resolve('/home/op/.glimmervoid');
  assert.equal(resolveCustomSoundsDir(home), path.join(home, 'sounds'));
});

test('a single byte range is served partially and clamped to the file size', () => {
  assert.deepEqual(decideByteRange('bytes=0-9', 100), { kind: 'partial', start: 0, end: 9 });
  assert.deepEqual(decideByteRange('bytes=90-', 100), { kind: 'partial', start: 90, end: 99 });
  assert.deepEqual(decideByteRange('bytes=90-500', 100), { kind: 'partial', start: 90, end: 99 });
  assert.deepEqual(decideByteRange('bytes=-10', 100), { kind: 'partial', start: 90, end: 99 });
  assert.deepEqual(decideByteRange('bytes=-500', 100), { kind: 'partial', start: 0, end: 99 });
  assert.deepEqual(decideByteRange('BYTES=5-5', 100), { kind: 'partial', start: 5, end: 5 });
});

test('a byte range starting past the end, or an empty suffix, is unsatisfiable', () => {
  assert.deepEqual(decideByteRange('bytes=100-', 100), { kind: 'unsatisfiable' });
  assert.deepEqual(decideByteRange('bytes=150-200', 100), { kind: 'unsatisfiable' });
  assert.deepEqual(decideByteRange('bytes=-0', 100), { kind: 'unsatisfiable' });
  assert.deepEqual(decideByteRange('bytes=0-', 0), { kind: 'unsatisfiable' });
  assert.deepEqual(decideByteRange('bytes=-5', 0), { kind: 'unsatisfiable' });
});

test('a missing, malformed, multi-part or foreign-unit range serves the whole file', () => {
  const wholeFileHeaders: unknown[] = [
    undefined,
    '',
    'bytes=',
    'bytes=-',
    'bytes=9-3',
    'bytes=abc-',
    'bytes=0-1,5-6',
    'items=0-9',
    ['bytes=0-9'],
  ];
  for (const header of wholeFileHeaders) {
    assert.deepEqual(decideByteRange(header, 100), { kind: 'full' }, `expected ${JSON.stringify(header)} to serve the whole file`);
  }
});
