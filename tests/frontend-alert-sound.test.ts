import test from 'node:test';
import assert from 'node:assert/strict';

import { playAlertSound } from '../public/alert-sound.ts';
import { DEFAULT_SOUND_ID, TONES_BY_SOUND_ID } from '../public/alert-sound-core.ts';

const CUSTOM_SOUND_ID = 'custom:alarm.ogg';
const CHIME_TONE_COUNT = TONES_BY_SOUND_ID[DEFAULT_SOUND_ID].tones.length;

const audioActivity = {
  startedBufferSources: 0,
  createdOscillators: 0,
  shouldDecodeFail: false,
};

function fakeAudioParam() {
  return { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} };
}

class RecordingAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};

  resume() {
    return Promise.resolve();
  }

  close() {
    return Promise.resolve();
  }

  createGain() {
    return { gain: fakeAudioParam(), connect() {} };
  }

  createOscillator() {
    audioActivity.createdOscillators += 1;
    return { type: 'sine', frequency: fakeAudioParam(), connect() {}, start() {}, stop() {} };
  }

  createBufferSource() {
    return {
      buffer: null,
      connect() {},
      start() {
        audioActivity.startedBufferSources += 1;
      },
    };
  }

  decodeAudioData() {
    if (audioActivity.shouldDecodeFail) return Promise.reject(new Error('undecodable audio'));
    return Promise.resolve({ duration: 0.01 });
  }
}

Object.defineProperty(globalThis, 'AudioContext', { value: RecordingAudioContext, configurable: true, writable: true });

function resetAudioActivity(shouldDecodeFail: boolean) {
  audioActivity.startedBufferSources = 0;
  audioActivity.createdOscillators = 0;
  audioActivity.shouldDecodeFail = shouldDecodeFail;
}

function serveCustomSound(response: Response) {
  globalThis.fetch = () => Promise.resolve(response);
}

async function settlePendingPlayback() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('a custom sound that fetches and decodes plays once and never plays the Chime', async () => {
  resetAudioActivity(false);
  serveCustomSound(new Response(new Uint8Array([1, 2, 3])));
  playAlertSound(CUSTOM_SOUND_ID);
  await settlePendingPlayback();
  assert.equal(audioActivity.startedBufferSources, 1);
  assert.equal(audioActivity.createdOscillators, 0);
});

test('a custom sound the server cannot serve plays the Chime once instead', async () => {
  resetAudioActivity(false);
  serveCustomSound(new Response('', { status: 404 }));
  playAlertSound(CUSTOM_SOUND_ID);
  await settlePendingPlayback();
  assert.equal(audioActivity.startedBufferSources, 0);
  assert.equal(audioActivity.createdOscillators, CHIME_TONE_COUNT);
});

test('a custom sound that fails to decode plays the Chime once instead', async () => {
  resetAudioActivity(true);
  serveCustomSound(new Response(new Uint8Array([1, 2, 3])));
  playAlertSound(CUSTOM_SOUND_ID);
  await settlePendingPlayback();
  assert.equal(audioActivity.startedBufferSources, 0);
  assert.equal(audioActivity.createdOscillators, CHIME_TONE_COUNT);
});
