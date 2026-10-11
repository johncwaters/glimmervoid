import type { Tone, ToneSequence } from '../alert-sound-core.ts';

const SCENE_IMPACT_SECONDS = 1.2;
const TITLE_REVEAL_SECONDS = 1.55;
const BEAT_SECONDS = 0.12;
const ROOT_FREQUENCY = 523.25;
const STEP_UP_SEMITONES = 2;
const MAX_STEP_UP_SEMITONES = 8;

interface JingleNote { semitone: number; startBeat: number; beats: number }
interface Jingle { melody: readonly JingleNote[]; bass: readonly JingleNote[] }

const note = (semitone: number, startBeat: number, beats: number): JingleNote => ({ semitone, startBeat, beats });

const SIGNATURE_CADENCE: Jingle = {
  melody: [note(7, 4, 0.5), note(11, 4.5, 0.5), note(12, 5, 3)],
  bass: [note(-5, 4, 1), note(-12, 5, 3)],
};

const OPENING_FIGURES: readonly Jingle[] = [
  {
    melody: [note(0, 0, 1), note(4, 1, 1), note(7, 2, 1), note(9, 3, 1)],
    bass: [note(-12, 0, 2), note(-8, 2, 2)],
  },
  {
    melody: [note(7, 0, 0.67), note(7, 0.67, 0.67), note(7, 1.33, 0.67), note(9, 2, 1), note(5, 3, 1)],
    bass: [note(-12, 0, 2), note(-7, 2, 2)],
  },
  {
    melody: [note(5, 0, 1), note(9, 1, 1), note(7, 2, 1), note(4, 3, 1)],
    bass: [note(-7, 0, 2), note(-12, 2, 2)],
  },
  {
    melody: [note(12, 0, 0.5), note(7, 0.5, 0.5), note(12, 1, 0.5), note(16, 1.5, 0.5), note(16, 2, 1), note(14, 3, 1)],
    bass: [note(-12, 0, 2), note(-3, 2, 2)],
  },
  {
    melody: [note(4, 0, 1), note(7, 1, 1), note(4, 2, 0.5), note(5, 2.5, 0.5), note(7, 3, 0.5), note(4, 3.5, 0.5)],
    bass: [note(-8, 0, 2), note(-12, 2, 2)],
  },
];

const CELEBRATION_JINGLES: readonly Jingle[] = OPENING_FIGURES.map((opening) => ({
  melody: [...opening.melody, ...SIGNATURE_CADENCE.melody],
  bass: [...opening.bass, ...SIGNATURE_CADENCE.bass],
}));

function frequencyOf(semitone: number, transposeSemitones: number): number {
  return ROOT_FREQUENCY * 2 ** ((semitone + transposeSemitones) / 12);
}

function jingleTones(jingle: Jingle, transposeSemitones: number): Tone[] {
  const voice = (notes: readonly JingleNote[], waveform: Tone['waveform'], gain: number): Tone[] => notes.map((jingleNote) => ({
    frequency: frequencyOf(jingleNote.semitone, transposeSemitones),
    startSeconds: TITLE_REVEAL_SECONDS + jingleNote.startBeat * BEAT_SECONDS,
    durationSeconds: jingleNote.beats * BEAT_SECONDS,
    waveform,
    gain,
  }));
  return [...voice(jingle.melody, 'square', 0.2), ...voice(jingle.melody, 'triangle', 0.5), ...voice(jingle.bass, 'triangle', 0.6)];
}

const ENTRY_AND_IMPACT_TONES: readonly Tone[] = [
  { frequency: 220, endFrequency: 880, startSeconds: 0, durationSeconds: 0.32, waveform: 'triangle', gain: 0.25 },
  { frequency: 160, endFrequency: 45, startSeconds: SCENE_IMPACT_SECONDS, durationSeconds: 0.28, waveform: 'sine', gain: 1 },
  { frequency: 1400, endFrequency: 380, startSeconds: SCENE_IMPACT_SECONDS, durationSeconds: 0.06, waveform: 'square', gain: 0.12 },
];

export function mergeCelebrationSound(positionInPlayThrough: number): ToneSequence {
  const jingle = CELEBRATION_JINGLES[positionInPlayThrough % CELEBRATION_JINGLES.length];
  const transposeSemitones = Math.min(positionInPlayThrough * STEP_UP_SEMITONES, MAX_STEP_UP_SEMITONES);
  return {
    peakGain: 0.1,
    tones: [...ENTRY_AND_IMPACT_TONES, ...jingleTones(jingle, transposeSemitones)],
  };
}
