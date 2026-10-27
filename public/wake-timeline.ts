import { sendControlMsg } from './control-ws.ts';
import { CLIENT_LOG_TEXT_MAX_CHARS } from '#shared/contracts/control-messages.ts';

export type WakeMarkName =
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

const WAKE_TIMELINE_CAP_MS = 30_000;

interface WakeTimeline {
  startedAtMs: number;
  hiddenForMs: number;
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

function hasTerminalOutput(timeline: WakeTimeline) {
  return timeline.marks.some((mark) => mark.startsWith('terminal-bytes'));
}

function sendWakeTimeline(timeline: WakeTimeline) {
  const outcome = hasTerminalOutput(timeline) && !timeline.isCapped ? 'terminal live' : `terminal not live after ${WAKE_TIMELINE_CAP_MS / 1000} s`;
  const text = `hidden ${Math.round(timeline.hiddenForMs / 1000)} s, ${outcome}, ${describeBrowser()}: ${timeline.marks.join(' ')}`;
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

export function noteWakeMark(name: WakeMarkName) {
  if (!currentTimeline) return;
  if (name === 'terminal-bytes' && hasTerminalOutput(currentTimeline)) return;
  currentTimeline.marks.push(`${name}+${Math.round(performance.now() - currentTimeline.startedAtMs)}`);
  if (name === 'terminal-bytes' || name === 'control-opened') endWakeTimelineOnceSent();
}

export function startWakeTimeline(name: 'shown' | 'resumed', hiddenForMs: number) {
  if (currentTimeline) {
    noteWakeMark(name);
    return;
  }
  currentTimeline = { startedAtMs: performance.now(), hiddenForMs, marks: [], isCapped: false, capTimer: setTimeout(capWakeTimeline, WAKE_TIMELINE_CAP_MS) };
  noteWakeMark(name);
}
