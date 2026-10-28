import { sendControlMsg } from './control-ws.ts';
import { CLIENT_LOG_TEXT_MAX_CHARS } from '#shared/contracts/control-messages.ts';

type WakeMarkName =
  | 'shown'
  | 'resumed'
  | 'control-connecting'
  | 'control-opened'
  | 'control-closed'
  | 'terminal-connecting'
  | 'terminal-abandoned'
  | 'terminal-closed'
  | 'terminal-opened'
  | 'terminal-bytes';

type NetworkMarkName = 'online' | 'offline' | 'link';

const WAKE_TIMELINE_CAP_MS = 30_000;
const DROPPED_MARKS_NOTE_MAX_CHARS = 24;

interface WakeTimeline {
  startedAtMs: number;
  hiddenForMs: number;
  networkAtWake: string;
  marks: string[];
  isCapped: boolean;
  capTimer: ReturnType<typeof setTimeout>;
}

let currentTimeline: WakeTimeline | null = null;

const PLATFORM_TOKENS = ['Android', 'iPhone', 'iPad', 'Windows', 'Mac OS X', 'Linux'];
const ENGINE_PATTERNS = [/Firefox\/\d+/, /Edg\/\d+/, /Chrome\/\d+/, /Version\/\d+/];

function describeBrowser() {
  const userAgent = navigator.userAgent;
  const platform = PLATFORM_TOKENS.find((token) => userAgent.includes(token)) ?? 'unknown platform';
  const engine = ENGINE_PATTERNS.map((pattern) => pattern.exec(userAgent)?.[0]).find((match) => match !== undefined)?.replace('Version', 'Safari') ?? 'unknown browser';
  return `${engine} on ${platform}`;
}

function readConnectionFacts() {
  const networkInformation: unknown = Reflect.get(navigator, 'connection');
  if (typeof networkInformation !== 'object' || networkInformation === null) return [];
  const connectionType: unknown = Reflect.get(networkInformation, 'type');
  const roundTripMs: unknown = Reflect.get(networkInformation, 'rtt');
  return [typeof connectionType === 'string' ? connectionType : '', typeof roundTripMs === 'number' ? `${roundTripMs}ms` : ''].filter((fact) => fact !== '');
}

function describeNetwork() {
  return [navigator.onLine ? 'online' : 'offline', ...readConnectionFacts()].join(' ');
}

function takeMarksWithin(marks: string[], maxChars: number) {
  const takenMarks: string[] = [];
  let usedChars = 0;
  for (const mark of marks) {
    const markChars = mark.length + 1;
    if (usedChars + markChars > maxChars) break;
    takenMarks.push(mark);
    usedChars += markChars;
  }
  return { takenMarks, usedChars };
}

function joinMarksWithin(marks: string[], maxChars: number) {
  const allMarks = marks.join(' ');
  if (allMarks.length <= maxChars) return allMarks;
  const marksBudget = maxChars - DROPPED_MARKS_NOTE_MAX_CHARS;
  const head = takeMarksWithin(marks, marksBudget / 2);
  const tail = takeMarksWithin(marks.slice(head.takenMarks.length).reverse(), marksBudget - head.usedChars);
  const droppedCount = marks.length - head.takenMarks.length - tail.takenMarks.length;
  return [...head.takenMarks, `(${droppedCount} marks dropped)`, ...tail.takenMarks.reverse()].join(' ');
}

function hasTerminalOutput(timeline: WakeTimeline) {
  return timeline.marks.some((mark) => mark.startsWith('terminal-bytes'));
}

function sendWakeTimeline(timeline: WakeTimeline) {
  const outcome = hasTerminalOutput(timeline) && !timeline.isCapped ? 'terminal live' : `terminal not live after ${WAKE_TIMELINE_CAP_MS / 1000} s`;
  const header = `hidden ${Math.round(timeline.hiddenForMs / 1000)} s, ${outcome}, ${describeBrowser()}, ${timeline.networkAtWake}: `;
  const text = header + joinMarksWithin(timeline.marks, CLIENT_LOG_TEXT_MAX_CHARS - header.length);
  return sendControlMsg({ type: 'client-log', scope: 'wake', text: text.slice(0, CLIENT_LOG_TEXT_MAX_CHARS) });
}

function endWakeTimelineOnceSent() {
  const timeline = currentTimeline;
  if (!timeline) return;
  if (!timeline.isCapped && !hasTerminalOutput(timeline)) return;
  if (!sendWakeTimeline(timeline)) return;
  currentTimeline = null;
  clearTimeout(timeline.capTimer);
}

function capWakeTimeline() {
  if (!currentTimeline) return;
  currentTimeline.isCapped = true;
  endWakeTimelineOnceSent();
}

function pushMark(timeline: WakeTimeline, label: string) {
  timeline.marks.push(`${label}+${Math.round(performance.now() - timeline.startedAtMs)}`);
}

export function noteWakeMark(name: WakeMarkName) {
  if (!currentTimeline) return;
  if (name === 'terminal-bytes' && hasTerminalOutput(currentTimeline)) return;
  pushMark(currentTimeline, name);
  if (name === 'terminal-bytes' || name === 'control-opened') endWakeTimelineOnceSent();
}

export function noteNetworkMark(name: NetworkMarkName) {
  if (!currentTimeline) return;
  pushMark(currentTimeline, name === 'link' ? ['link', ...readConnectionFacts()].join('-') : name);
}

export function startWakeTimeline(name: 'shown' | 'resumed', hiddenForMs: number) {
  if (currentTimeline) {
    noteWakeMark(name);
    return;
  }
  currentTimeline = { startedAtMs: performance.now(), hiddenForMs, networkAtWake: describeNetwork(), marks: [], isCapped: false, capTimer: setTimeout(capWakeTimeline, WAKE_TIMELINE_CAP_MS) };
  noteWakeMark(name);
}
