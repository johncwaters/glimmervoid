import { STATES } from "../../shared/states.ts";
import type { SessionState } from "../../shared/states.ts";
import { AGENT_ATTENTION_NOTE_SEPARATOR, ATTENTION_NOTE_MAX_CHARS, AttentionNoteOrigin } from "../../shared/contracts/session.ts";
import type { AttentionNote, AttentionOrigin } from "../../shared/contracts/session.ts";
import { mapSignalToEvent } from "./status-mapper.ts";
import { TRANSITIONS } from "./state-machine.ts";

const QUESTION_LANES = Object.freeze({ CLEAR: "clear", HELD: "held", ASKING: "asking" } as const);
type QuestionLane = (typeof QUESTION_LANES)[keyof typeof QUESTION_LANES];
type QuestionEvent = "question_early" | "question" | "accepting" | "answered" | "teardown";

const NOTE_LANES = Object.freeze({ CLEAR: "clear", NOTED: "noted" } as const);
type NoteLane = (typeof NOTE_LANES)[keyof typeof NOTE_LANES];
type NoteEvent = "note" | "operator_prompt" | "dismiss" | "teardown";

const QUESTION_TRANSITIONS: Readonly<Record<QuestionLane, Readonly<Partial<Record<QuestionEvent, QuestionLane>>>>> = Object.freeze({
  [QUESTION_LANES.CLEAR]: { question_early: QUESTION_LANES.HELD, question: QUESTION_LANES.ASKING },
  [QUESTION_LANES.HELD]: { question_early: QUESTION_LANES.HELD, question: QUESTION_LANES.ASKING, accepting: QUESTION_LANES.ASKING, teardown: QUESTION_LANES.CLEAR },
  [QUESTION_LANES.ASKING]: { question: QUESTION_LANES.ASKING, answered: QUESTION_LANES.CLEAR, teardown: QUESTION_LANES.CLEAR },
});

const NOTE_TRANSITIONS: Readonly<Record<NoteLane, Readonly<Partial<Record<NoteEvent, NoteLane>>>>> = Object.freeze({
  [NOTE_LANES.CLEAR]: { note: NOTE_LANES.NOTED },
  [NOTE_LANES.NOTED]: { note: NOTE_LANES.NOTED, operator_prompt: NOTE_LANES.CLEAR, dismiss: NOTE_LANES.CLEAR, teardown: NOTE_LANES.CLEAR },
});

const MAX_HELD_QUESTIONS = 5;

const STARTUP_STATES: readonly SessionState[] = Object.freeze([STATES.DORMANT, STATES.INITIALIZING, STATES.STARTING]);

type AttentionDisposition = "held" | "raised" | "flagged" | "released" | "answered" | "cleared" | "refused";

interface AttentionLanes {
  question: QuestionLane;
  held: string[];
  notes: Partial<Record<AttentionNoteOrigin, AttentionNote>>;
}

type AttentionEvent =
  | { type: "raise"; origin: AttentionOrigin; note: string; at: number; state: SessionState }
  | { type: "state"; state: SessionState; leftWaiting: boolean }
  | { type: "operator_prompt" }
  | { type: "dismiss" }
  | { type: "teardown" };

interface AttentionRecord {
  disposition: AttentionDisposition;
  origin: AttentionOrigin | null;
  note: string | null;
}

interface AttentionEffect {
  records: AttentionRecord[];
  askingNote: string | null;
  hasNotesChanged: boolean;
  refusal: string | null;
  isHeld: boolean;
}

const NO_EFFECT: AttentionEffect = Object.freeze({ records: [], askingNote: null, hasNotesChanged: false, refusal: null, isHeld: false });

function createAttentionLanes(): AttentionLanes {
  return { question: QUESTION_LANES.CLEAR, held: [], notes: {} };
}

function acceptsQuestion(state: SessionState): boolean {
  if (mapSignalToEvent("awaiting-input", state, "high", 0) !== "prompt_detected") return false;
  return "prompt_detected" in TRANSITIONS[state];
}

function isStartupState(state: SessionState): boolean {
  return !acceptsQuestion(state) && STARTUP_STATES.includes(state);
}

function oneLineNote(note: string): string {
  return note.replace(/\s+/g, " ").trim().slice(0, ATTENTION_NOTE_MAX_CHARS);
}

function nextQuestionLane(lane: QuestionLane, event: QuestionEvent): QuestionLane | null {
  return QUESTION_TRANSITIONS[lane][event] ?? null;
}

function nextNoteLane(lanes: AttentionLanes, event: NoteEvent): NoteLane | null {
  const current = Object.keys(lanes.notes).length > 0 ? NOTE_LANES.NOTED : NOTE_LANES.CLEAR;
  return NOTE_TRANSITIONS[current][event] ?? null;
}

function raiseNote(lanes: AttentionLanes, origin: AttentionNoteOrigin, note: string, at: number): { lanes: AttentionLanes; effect: AttentionEffect } {
  if (nextNoteLane(lanes, "note") === null) return { lanes, effect: NO_EFFECT };
  const notes = { ...lanes.notes, [origin]: { origin, note, at } };
  return { lanes: { ...lanes, notes }, effect: { ...NO_EFFECT, records: [{ disposition: "flagged", origin, note }], hasNotesChanged: true } };
}

function raiseQuestion(lanes: AttentionLanes, origin: AttentionOrigin, note: string, state: SessionState): { lanes: AttentionLanes; effect: AttentionEffect } {
  if (!isStartupState(state)) {
    const question = nextQuestionLane(lanes.question, "question") ?? lanes.question;
    return { lanes: { ...lanes, question }, effect: { ...NO_EFFECT, records: [{ disposition: "raised", origin, note }], askingNote: note } };
  }
  if (lanes.held.length >= MAX_HELD_QUESTIONS) {
    const refusal = `the session is already holding ${MAX_HELD_QUESTIONS} attention notes; wait until it can accept input`;
    return { lanes, effect: { ...NO_EFFECT, records: [{ disposition: "refused", origin, note }], refusal } };
  }
  const question = nextQuestionLane(lanes.question, "question_early") ?? lanes.question;
  return { lanes: { ...lanes, question, held: [...lanes.held, note] }, effect: { ...NO_EFFECT, records: [{ disposition: "held", origin, note }], isHeld: true } };
}

function observeState(lanes: AttentionLanes, state: SessionState, leftWaiting: boolean): { lanes: AttentionLanes; effect: AttentionEffect } {
  const accepted = acceptsQuestion(state) ? nextQuestionLane(lanes.question, "accepting") : null;
  if (accepted !== null) {
    const askingNote = lanes.held.join(AGENT_ATTENTION_NOTE_SEPARATOR);
    return { lanes: { ...lanes, question: accepted, held: [] }, effect: { ...NO_EFFECT, records: [{ disposition: "released", origin: null, note: askingNote }], askingNote } };
  }
  if (!leftWaiting) return { lanes, effect: NO_EFFECT };
  const question = nextQuestionLane(lanes.question, "answered");
  if (question === null) return { lanes, effect: NO_EFFECT };
  return { lanes: { ...lanes, question }, effect: { ...NO_EFFECT, records: [{ disposition: "answered", origin: null, note: null }] } };
}

function clearNotes(lanes: AttentionLanes, event: NoteEvent): { lanes: AttentionLanes; effect: AttentionEffect } {
  if (nextNoteLane(lanes, event) !== NOTE_LANES.CLEAR) return { lanes, effect: NO_EFFECT };
  return { lanes: { ...lanes, notes: {} }, effect: { ...NO_EFFECT, records: [{ disposition: "cleared", origin: null, note: null }], hasNotesChanged: true } };
}

function tearDown(lanes: AttentionLanes): { lanes: AttentionLanes; effect: AttentionEffect } {
  const question = nextQuestionLane(lanes.question, "teardown") ?? lanes.question;
  const notesCleared = clearNotes(lanes, "teardown");
  return { lanes: { question, held: [], notes: notesCleared.lanes.notes }, effect: notesCleared.effect };
}

function reduceAttention(lanes: AttentionLanes, event: AttentionEvent): { lanes: AttentionLanes; effect: AttentionEffect } {
  switch (event.type) {
    case "raise": {
      const note = oneLineNote(event.note);
      const noteOrigin = AttentionNoteOrigin.safeParse(event.origin);
      if (noteOrigin.success) return raiseNote(lanes, noteOrigin.data, note, event.at);
      return raiseQuestion(lanes, event.origin, note, event.state);
    }
    case "state":
      return observeState(lanes, event.state, event.leftWaiting);
    case "operator_prompt":
      return clearNotes(lanes, "operator_prompt");
    case "dismiss":
      return clearNotes(lanes, "dismiss");
    case "teardown":
      return tearDown(lanes);
  }
}

function attentionNotesOf(lanes: AttentionLanes): AttentionNote[] {
  return Object.values(lanes.notes).filter((note) => note !== undefined).sort((left, right) => right.at - left.at);
}

export { attentionNotesOf, createAttentionLanes, reduceAttention };
export type { AttentionEvent, AttentionLanes };
