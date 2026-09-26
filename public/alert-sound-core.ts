export interface SoundOption {
  id: string;
  label: string;
}

export interface Tone {
  frequency: number;
  startSeconds: number;
  durationSeconds: number;
  waveform: 'sine' | 'triangle' | 'square';
}

export const DEFAULT_SOUND_ID = 'chime';
const CUSTOM_SOUND_PREFIX = 'custom:';
export const CUSTOM_SOUNDS_ROUTE = '/custom-sounds';

export const TONES_BY_SOUND_ID: Readonly<Record<string, { label: string; peakGain: number; tones: Tone[] }>> = Object.freeze({
  chime: {
    label: 'Chime',
    peakGain: 0.12,
    tones: [
      { frequency: 659.25, startSeconds: 0, durationSeconds: 0.35, waveform: 'sine' },
      { frequency: 987.77, startSeconds: 0.14, durationSeconds: 0.5, waveform: 'sine' },
    ],
  },
  ping: {
    label: 'Soft ping',
    peakGain: 0.08,
    tones: [
      { frequency: 1046.5, startSeconds: 0, durationSeconds: 0.12, waveform: 'triangle' },
      { frequency: 1046.5, startSeconds: 0.13, durationSeconds: 0.12, waveform: 'triangle' },
      { frequency: 1318.51, startSeconds: 0.26, durationSeconds: 0.2, waveform: 'triangle' },
    ],
  },
  beep: {
    label: 'Beep',
    peakGain: 0.15,
    tones: [{ frequency: 880, startSeconds: 0, durationSeconds: 0.2, waveform: 'sine' }],
  },
});

const BUILT_IN_SOUND_OPTIONS: readonly SoundOption[] = Object.freeze(
  Object.entries(TONES_BY_SOUND_ID).map(([id, sound]) => ({ id, label: sound.label })),
);

function customSoundId(fileName: string): string {
  return `${CUSTOM_SOUND_PREFIX}${fileName}`;
}

export function customSoundUrl(fileName: string): string {
  return `${CUSTOM_SOUNDS_ROUTE}/${encodeURIComponent(fileName)}`;
}

export function customSoundFileName(soundId: string): string | null {
  if (!soundId.startsWith(CUSTOM_SOUND_PREFIX)) return null;
  return soundId.slice(CUSTOM_SOUND_PREFIX.length) || null;
}

export function soundOptions(customSoundNames: readonly string[] | null): SoundOption[] {
  const customOptions = (customSoundNames ?? []).map((fileName) => ({ id: customSoundId(fileName), label: fileName }));
  return [...BUILT_IN_SOUND_OPTIONS, ...customOptions];
}

export function resolveSoundId(soundId: unknown, customSoundNames: readonly string[] | null): string {
  if (typeof soundId !== 'string') return DEFAULT_SOUND_ID;
  if (Object.hasOwn(TONES_BY_SOUND_ID, soundId)) return soundId;
  const fileName = customSoundFileName(soundId);
  if (!fileName) return DEFAULT_SOUND_ID;
  if (customSoundNames === null || customSoundNames.includes(fileName)) return soundId;
  return DEFAULT_SOUND_ID;
}

export function parseCustomSoundList(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || !('sounds' in body) || !Array.isArray(body.sounds)) return [];
  return body.sounds.filter((name: unknown): name is string => typeof name === 'string' && name !== '');
}
