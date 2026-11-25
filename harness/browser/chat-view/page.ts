import type { TraceRecord } from '../../../shared/contracts/trace.ts';
import type { ChatPart, TurnPart } from '../../../public/chat/chat-part.ts';
import { appendChatRecords, createChatPartsState, endChatTurn } from '../../../public/chat/chat-parts-core.ts';
import { createChatFeed } from '../../../public/chat/chat-feed.ts';
import { railFieldsOf } from '../../../public/chat/status-rail-core.ts';
import { CHAT_NEAR_TOP_EVENT, createChatView, NO_ARRIVING_PARTS } from '../../../public/chat/chat-view.ts';

const EXAMPLE_CARD_PARTS: ChatPart[] = [
  {
    kind: 'card',
    id: 'example-question-multi',
    card: {
      cardType: 'question',
      cardId: 'example-question-multi',
      data: { question: 'Which audit gaps should this round fix?', detail: 'Scope', multiSelect: true, options: [{ label: 'Rail never empty (Recommended)', note: 'Status rail shows the agent name until a meter arrives.' }, { label: 'Labeled Diff', note: 'The turn meta gets a Diff button.' }, { label: 'Static pulses', note: 'No looping animations.' }] },
      resolution: null,
    },
  },
  { kind: 'card', id: 'example-notice', card: { cardType: 'notice', cardId: 'example-notice', data: { text: 'Context compacted' }, resolution: null } },
  { kind: 'card', id: 'example-permission', card: { cardType: 'permission', cardId: 'example-permission', data: { title: 'Run Bash', detail: 'npm run typecheck' }, resolution: null } },
  { kind: 'card', id: 'example-permission-allowed', card: { cardType: 'permission', cardId: 'example-permission-allowed', data: { title: 'Edit public/chat/chat.css', detail: '' }, resolution: { decision: 'allow' } } },
  { kind: 'card', id: 'example-permission-denied', card: { cardType: 'permission', cardId: 'example-permission-denied', data: { title: 'Run Bash', detail: 'rm -rf build' }, resolution: { decision: 'deny', message: 'Run npm run clean instead' } } },
  {
    kind: 'card',
    id: 'example-question',
    card: {
      cardType: 'question',
      cardId: 'example-question',
      data: { question: 'Which layout should the composer use?', detail: 'Composer', step: '1 of 2', options: [{ label: 'Docked (Recommended)', note: 'Pinned to the bottom of the pane, so the input stays in one place while replies arrive and the Stop control never moves. Cost: the last reply loses two lines of height.' }, { label: 'Inline', note: 'Follows the last reply.' }] },
      resolution: null,
    },
  },
  { kind: 'card', id: 'example-question-answered', card: { cardType: 'question', cardId: 'example-question-answered', data: { question: 'Land now?', detail: '', options: [] }, resolution: { answer: 'Yes' } } },
  { kind: 'card', id: 'example-question-dismissed', card: { cardType: 'question', cardId: 'example-question-dismissed', data: { question: 'Which store?', detail: 'Storage', options: [] }, resolution: { isDismissed: true } } },
];

const chatHost = document.getElementById('chat-host');
const traceResponse = await fetch('/trace-records.json');
const { records: traceRecords }: { records: TraceRecord[] } = await traceResponse.json();
const harnessUploadUrlOf = (fileName: string) => (fileName.endsWith('.png') ? new URL('../../../public/animals/sprite-cow.png', import.meta.url).href : `/missing-upload/${encodeURIComponent(fileName)}`);
const chatView = createChatView(harnessUploadUrlOf);
chatHost?.appendChild(chatView.element);
chatView.setPhase('working', true);
const HARNESS_NOW_MS = Date.now();
const EXAMPLE_METER = { model: 'Example Large 2', effort: 'medium', contextTokens: 167_000, contextWindow: 300_000, callCostUSD: 0.0334, outputStyle: 'Explanatory' };
const EXAMPLE_PLAN_LIMITS = { fiveHour: { pct: 12, resetsAtMs: HARNESS_NOW_MS + 2 * 3_600_000 }, sevenDay: { pct: 44, resetsAtMs: HARNESS_NOW_MS + 3.4 * 86_400_000 } };
function showExampleRail(): void {
  chatView.showRail(railFieldsOf({ meter: EXAMPLE_METER, selection: null, planLimits: EXAMPLE_PLAN_LIMITS, sessionCostUSD: 186.39, nowMs: HARNESS_NOW_MS, agent: 'claude-code' }));
}
showExampleRail();
const LIVE_PAGE_RECORDS = 25;
const LIVE_PAGE_INTERVAL_MS = 20;

async function playLive(): Promise<void> {
  let servedCount = Math.min(LIVE_PAGE_RECORDS, traceRecords.length);
  const feed = createChatFeed({
    sessionId: 'harness',
    workingDirectory: null,
    requestPage: async (payload) => {
      const start = 'after' in payload ? payload.after : 0;
      return { type: 'session-trace-response', id: 'harness', requestId: 'harness', records: traceRecords.slice(start, servedCount), start, next: servedCount, reset: false, path: '' };
    },
    onPartsChanged: (changedParts, droppedPartIds, isLive) => {
      chatView.upsert(changedParts, isLive ? new Set(changedParts.map((part) => part.id)) : NO_ARRIVING_PARTS);
      chatView.remove(droppedPartIds);
    },
    isTurnOver: () => false,
    onBeats: (beats) => {
      document.body.dataset.beatCount = String(Number(document.body.dataset.beatCount ?? 0) + beats.length);
      chatView.beat(beats);
    },
    onReset: () => {},
    onRebuilt: (rebuiltParts, replacedPartIds) => chatView.replaceLogParts(replacedPartIds, rebuiltParts),
    onFailure: (failureText) => { if (failureText) document.body.dataset.feedFailure = failureText; },
  });
  feed.refresh();
  while (servedCount < traceRecords.length) {
    await new Promise((resolve) => setTimeout(resolve, LIVE_PAGE_INTERVAL_MS));
    servedCount = Math.min(servedCount + LIVE_PAGE_RECORDS, traceRecords.length);
    feed.refresh();
  }
  await new Promise((resolve) => setTimeout(resolve, LIVE_PAGE_INTERVAL_MS));
  if (new URLSearchParams(location.search).has('working')) return;
  while (chatView.element.querySelector('[data-arriving]')) await new Promise((resolve) => requestAnimationFrame(resolve));
  const partTopsBefore = partTops();
  chatView.setPhase('quiet', false);
  feed.endTurn();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const partTopsAfter = partTops();
  const turnEndShiftPx = Math.max(0, ...partTopsBefore.map((top, partIndex) => Math.abs(top - (partTopsAfter[partIndex] ?? top))));
  document.body.dataset.turnEndShiftPx = String(turnEndShiftPx);
  document.body.dataset.liveDone = 'true';
}

const EARLIER_PAGE_RECORDS = 40;
const EARLIER_PAGE_REPLY_MS = Number(new URLSearchParams(location.search).get('reply') ?? '100');

function playEarlier(): void {
  const feed = createChatFeed({
    sessionId: 'harness',
    workingDirectory: null,
    requestPage: async (payload) => {
      if (EARLIER_PAGE_REPLY_MS > 0) await new Promise((resolve) => setTimeout(resolve, EARLIER_PAGE_REPLY_MS));
      const pageEnd = 'endingAt' in payload && typeof payload.endingAt === 'number' ? payload.endingAt : traceRecords.length;
      const pageStart = Math.max(0, pageEnd - EARLIER_PAGE_RECORDS);
      document.body.dataset.earliestOffset = String(pageStart);
      return { type: 'session-trace-response', id: 'harness', requestId: 'harness', records: traceRecords.slice(pageStart, pageEnd), start: pageStart, next: pageEnd, reset: false, path: '' };
    },
    onPartsChanged: (changedParts, droppedPartIds) => {
      chatView.upsert(changedParts, NO_ARRIVING_PARTS);
      chatView.remove(droppedPartIds);
      if (harnessMode.has('cards')) chatView.upsert(EXAMPLE_CARD_PARTS, NO_ARRIVING_PARTS);
    },
    isTurnOver: () => true,
    onBeats: () => {},
    onReset: () => {},
    onRebuilt: (rebuiltParts, replacedPartIds) => chatView.replaceLogParts(replacedPartIds, rebuiltParts),
    onFailure: (failureText) => { if (failureText) document.body.dataset.feedFailure = failureText; },
  });
  chatView.element.addEventListener(CHAT_NEAR_TOP_EVENT, () => feed.loadEarlier());
  feed.refresh();
}

function partTops(): number[] {
  return Array.from(chatView.element.querySelectorAll('[data-part-id]'), (part) => part.getBoundingClientRect().top);
}

function showRecordsAtRest(): void {
  const partsState = createChatPartsState();
  const appended = appendChatRecords(partsState, traceRecords);
  const restingParts = [...appended.parts, ...endChatTurn(partsState)];
  chatView.upsert(restingParts, NO_ARRIVING_PARTS);
  window.addEventListener('harness-remount-chat', () => {
    const remountedView = createChatView(harnessUploadUrlOf);
    remountedView.upsert(restingParts, NO_ARRIVING_PARTS);
    remountedView.showLoaded();
    document.querySelector('.chat-view')?.replaceWith(remountedView.element);
  });
}

const BOOT_STEP_MS = 900;

async function playBoot(): Promise<void> {
  const pause = () => new Promise((resolve) => setTimeout(resolve, BOOT_STEP_MS));
  chatView.setPhase('starting', false);
  const sentText = await new Promise<string>((resolve) => {
    chatView.element.addEventListener('chat-send', (event) => resolve(event instanceof CustomEvent ? String(event.detail.text) : ''), { once: true });
  });
  chatView.showQueued([{ entryId: 'boot-held', text: sentText, attachments: [], state: 'held', failure: null, shouldOpenTerminal: false, origin: 'operator' }]);
  await pause();
  chatView.setPhase('quiet', false);
  await pause();
  chatView.setPhase('working', true);
  await pause();
  document.body.dataset.bootDone = 'true';
}

const VOLATILE_TEXT_SELECTOR = '.chat-activity-verb, .chat-activity-detail, .chat-subagent-time, .chat-limit-countdown';
const VOLATILE_ATTRIBUTES_BY_SELECTOR: readonly [string, readonly string[]][] = [
  ['.chat-activity', ['aria-label', 'data-typing']],
  ['.chat-card', ['data-keys-ready']],
];

function volatileAttributesOf(element: Element): ReadonlySet<string> {
  return new Set(VOLATILE_ATTRIBUTES_BY_SELECTOR.flatMap(([selector, attributeNames]) => (element.matches(selector) ? attributeNames : [])));
}

function directTextOf(element: Element): string {
  if (element.matches(VOLATILE_TEXT_SELECTOR)) return '<volatile>';
  const directText = [...element.childNodes].filter((child) => child.nodeType === Node.TEXT_NODE).map((child) => child.textContent ?? '').join('');
  return directText.replace(/\s+/g, ' ').trim();
}

function normalizedAttributeValue(name: string, value: string): string {
  if (name !== 'src' && name !== 'href') return value;
  const withoutOrigin = value.startsWith(location.origin) ? value.slice(location.origin.length) : value;
  return withoutOrigin.replace(/^\/@fs\/.*\/(public\/.*)$/, '/$1');
}

function elementLineOf(element: Element, depth: number): string {
  const volatileAttributes = volatileAttributesOf(element);
  const attributes = [...element.attributes]
    .filter((attribute) => !volatileAttributes.has(attribute.name))
    .map((attribute) => `${attribute.name}=${JSON.stringify(normalizedAttributeValue(attribute.name, attribute.value))}`)
    .sort();
  const text = directTextOf(element);
  const value = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement ? ` value=${JSON.stringify(element.value)}` : '';
  return `${'  '.repeat(depth)}${element.tagName.toLowerCase()} ${attributes.join(' ')}${value}${text === '' ? '' : ` | ${text}`}`;
}

function fingerprintLinesOf(root: Element): string[] {
  const lines: string[] = [];
  const pendingElements: { element: Element; depth: number }[] = [{ element: root, depth: 0 }];
  while (pendingElements.length > 0) {
    const pending = pendingElements.pop();
    if (!pending) continue;
    lines.push(elementLineOf(pending.element, pending.depth));
    pendingElements.push(...[...pending.element.children].reverse().map((child) => ({ element: child, depth: pending.depth + 1 })));
  }
  return lines;
}

function medianOf(samples: readonly number[]): number {
  const sorted = [...samples].sort((first, second) => first - second);
  return Math.round((sorted[Math.floor(sorted.length / 2)] ?? 0) * 100) / 100;
}

function measureRendering(runCount: number): void {
  const partsMs: number[] = [];
  const restUpsertMs: number[] = [];
  const rebuildMs: number[] = [];
  let partCount = 0;
  for (let run = 0; run < runCount; run += 1) {
    const partsStart = performance.now();
    const partsState = createChatPartsState();
    const appended = appendChatRecords(partsState, traceRecords);
    const restingParts = [...appended.parts, ...endChatTurn(partsState)];
    const upsertStart = performance.now();
    const measuredView = createChatView(harnessUploadUrlOf);
    chatHost?.replaceChildren(measuredView.element);
    measuredView.showLoaded();
    measuredView.upsert(restingParts, NO_ARRIVING_PARTS);
    void measuredView.element.offsetHeight;
    const rebuildStart = performance.now();
    measuredView.replaceLogParts(restingParts.map((part) => part.id), restingParts);
    void measuredView.element.offsetHeight;
    const rebuildEnd = performance.now();
    partsMs.push(upsertStart - partsStart);
    restUpsertMs.push(rebuildStart - upsertStart);
    rebuildMs.push(rebuildEnd - rebuildStart);
    partCount = restingParts.length;
  }
  document.body.dataset.perf = JSON.stringify({ records: traceRecords.length, parts: partCount, runs: runCount, partsMs: medianOf(partsMs), restUpsertMs: medianOf(restUpsertMs), rebuildMs: medianOf(rebuildMs) });
}

Object.assign(window, { chatFingerprint: () => fingerprintLinesOf(document.querySelector('.chat-view') ?? document.body) });

const harnessMode = new URLSearchParams(location.search);
const perfRunCount = Number(harnessMode.get('perf') ?? '0');
if (perfRunCount > 0) measureRendering(perfRunCount);
if (harnessMode.has('boot')) void playBoot();
if (harnessMode.has('live')) await playLive();
if (harnessMode.has('earlier')) playEarlier();
if (!harnessMode.has('loading')) chatView.showLoaded();
if (!harnessMode.has('live') && !harnessMode.has('boot') && !harnessMode.has('earlier')) showRecordsAtRest();
if (harnessMode.has('cards') && !harnessMode.has('earlier')) chatView.upsert(EXAMPLE_CARD_PARTS, NO_ARRIVING_PARTS);
if (harnessMode.has('monitoring')) {
  chatView.setPhase('monitoring', false);
  setInterval(() => chatView.tickRunTimes(), 1000);
}
if (harnessMode.has('narrating')) {
  chatView.setPhase('working', true);
  const narration = { kind: 'text', text: "Checking bisect step it's on:" } as const;
  const narrationTurnStates: TurnPart['segments'][] = [
    [narration, { kind: 'tools', calls: [{ toolUseId: 'narration-0', label: 'git bisect log', skillName: null, state: 'running' as const, startedAt: 0, durationMs: null, outputHead: null, imageFileNames: [] }], callCount: 1, settledCount: 0 }],
    [narration, { kind: 'tools', calls: [{ toolUseId: 'narration-0', label: 'git bisect log', skillName: null, state: 'running' as const, startedAt: 0, durationMs: null, outputHead: null, imageFileNames: [] }, { toolUseId: 'narration-1', label: 'Read the bisect script and its trail of skipped commits', skillName: null, state: 'running' as const, startedAt: 0, durationMs: null, outputHead: null, imageFileNames: [] }], callCount: 2, settledCount: 0 }],
    [narration, { kind: 'tools', calls: [{ toolUseId: 'narration-0', label: 'git bisect log', skillName: null, state: 'running' as const, startedAt: 0, durationMs: null, outputHead: null, imageFileNames: [] }, { toolUseId: 'narration-1', label: 'Read the bisect script and its trail of skipped commits', skillName: null, state: 'running' as const, startedAt: 0, durationMs: null, outputHead: null, imageFileNames: [] }, { toolUseId: 'narration-2', label: 'git status', skillName: null, state: 'running' as const, startedAt: 0, durationMs: null, outputHead: null, imageFileNames: [] }], callCount: 3, settledCount: 0 }],
  ];
  let narrationStep = 0;
  const showNextNarrationState = () => {
    const segments = narrationTurnStates[narrationStep % narrationTurnStates.length] ?? [];
    narrationStep += 1;
    chatView.upsert([{ kind: 'turn', id: 'narrating-turn', openedAt: null, segments, droppedSegmentCount: 0, toolCount: 0, skillCount: 0, failedCount: 0, fileEdits: { fileCount: 0, added: 0, removed: 0, hasLineCounts: false }, filePatches: [], unshownPatchCount: 0, thoughtText: null, thinkingText: null, durationText: null, taskList: null, outputTokens: null, isOver: false }], NO_ARRIVING_PARTS);
  };
  showNextNarrationState();
  setInterval(showNextNarrationState, 700);
}
document.addEventListener('chat-card', (event) => {
  if (event instanceof CustomEvent) document.body.dataset.lastCardAction = JSON.stringify(event.detail);
});
for (const eventName of ['chat-send', 'chat-stop']) {
  document.addEventListener(eventName, (event) => {
    document.body.dataset.lastComposerEvent = JSON.stringify({ eventName, detail: event instanceof CustomEvent ? event.detail : null });
  });
}
document.body.dataset.rendered = 'true';
