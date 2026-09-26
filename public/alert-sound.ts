import {
  CUSTOM_SOUNDS_ROUTE,
  DEFAULT_SOUND_ID,
  TONES_BY_SOUND_ID,
  customSoundFileName,
  customSoundUrl,
  parseCustomSoundList,
  resolveSoundId as resolveSoundIdAgainst,
  soundOptions as soundOptionsFrom,
} from './alert-sound-core.ts';
import type { SoundOption } from './alert-sound-core.ts';

const CUSTOM_SOUND_VOLUME = 0.3;

let knownCustomSoundNames: readonly string[] | null = null;

export function soundOptions(): SoundOption[] {
  return soundOptionsFrom(knownCustomSoundNames);
}

export function resolveSoundId(soundId: unknown): string {
  return resolveSoundIdAgainst(soundId, knownCustomSoundNames);
}

export async function loadCustomSounds(): Promise<void> {
  try {
    const response = await fetch(CUSTOM_SOUNDS_ROUTE, { credentials: 'same-origin', cache: 'no-store' });
    if (response.ok) knownCustomSoundNames = parseCustomSoundList(await response.json());
  } catch {
  }
}

function playTones(soundId: string) {
  const sound = TONES_BY_SOUND_ID[soundId] ?? TONES_BY_SOUND_ID[DEFAULT_SOUND_ID];
  const audioContext = new AudioContext();
  if (audioContext.state === 'suspended') audioContext.resume();
  const master = audioContext.createGain();
  master.gain.value = sound.peakGain;
  master.connect(audioContext.destination);
  const now = audioContext.currentTime;
  let lastEndSeconds = 0;
  for (const tone of sound.tones) {
    const start = now + tone.startSeconds;
    const end = start + tone.durationSeconds;
    const oscillator = audioContext.createOscillator();
    const toneGain = audioContext.createGain();
    oscillator.type = tone.waveform;
    oscillator.frequency.value = tone.frequency;
    toneGain.gain.setValueAtTime(0.001, start);
    toneGain.gain.exponentialRampToValueAtTime(1, start + 0.01);
    toneGain.gain.exponentialRampToValueAtTime(0.001, end);
    oscillator.connect(toneGain);
    toneGain.connect(master);
    oscillator.start(start);
    oscillator.stop(end);
    lastEndSeconds = Math.max(lastEndSeconds, tone.startSeconds + tone.durationSeconds);
  }
  setTimeout(() => audioContext.close().catch(() => {}), (lastEndSeconds + 0.1) * 1000);
}

const NYAN_NOTES = [
  659.25, 830.61, 987.77, 1108.73, 987.77, 830.61, 739.99, 659.25,
  739.99, 830.61, 987.77, 1108.73, 987.77, 830.61,
];

export function playNyanJingle() {
  try {
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    if (ctx.state === 'suspended') return;

    const master = ctx.createGain();
    master.gain.value = 0.05;
    master.connect(ctx.destination);

    const noteLen = 0.125;
    const now = ctx.currentTime;

    for (let i = 0; i < NYAN_NOTES.length; i++) {
      const start = now + i * noteLen;
      const osc = ctx.createOscillator();
      const noteGain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = NYAN_NOTES[i];
      noteGain.gain.setValueAtTime(0.001, start);
      noteGain.gain.exponentialRampToValueAtTime(1, start + 0.01);
      noteGain.gain.exponentialRampToValueAtTime(0.001, start + noteLen * 0.9);
      osc.connect(noteGain);
      noteGain.connect(master);
      osc.start(start);
      osc.stop(start + noteLen);
    }

    const end = now + NYAN_NOTES.length * noteLen;
    master.gain.setValueAtTime(0.05, end - 0.05);
    master.gain.exponentialRampToValueAtTime(0.001, end);

    setTimeout(() => ctx.close().catch(() => {}), (end - now + 0.1) * 1000);
  } catch {
  }
}

function playDefaultSoundInstead() {
  try {
    playTones(DEFAULT_SOUND_ID);
  } catch {
  }
}

export function playAlertSound(soundId: string) {
  try {
    const resolvedSoundId = resolveSoundId(soundId);
    const fileName = customSoundFileName(resolvedSoundId);
    if (!fileName) {
      playTones(resolvedSoundId);
      return;
    }
    const audio = new Audio(customSoundUrl(fileName));
    audio.volume = CUSTOM_SOUND_VOLUME;
    audio.play().catch(playDefaultSoundInstead);
  } catch {
  }
}
