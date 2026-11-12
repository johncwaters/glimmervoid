import { PACK_BRIDGE_VERSION, PACK_DATA_MAX_BYTES, PACK_STORE_MAX_DEPTH, PackBridgeTopic, type PackBridgeTopicData } from '../../../shared/contracts/pack-bridge.ts';
import type { MyPr } from '../../../shared/contracts/my-prs.ts';
import type { PackOnDisk } from '../../../shared/contracts/pack.ts';
import type { ReviewsSnapshot } from '../../../shared/contracts/reviews.ts';
import type { QueuedReview, ReviewDraft } from '../../../shared/contracts/team-review.ts';
import type { ThemePalette } from '../../../shared/contracts/theme-palette.ts';
import { STATES } from '../../../shared/states.ts';
import { themeCssColors } from '../../../shared/theme-colors-core.ts';

const HOUR_MS = 60 * 60 * 1000;

const SAMPLE_PALETTE: ThemePalette = {
  label: 'Sample dark', mode: 'dark', accentAnsiSlot: 'blue',
  chrome: {
    'bg': '#0d1117', 'bg-card': '#11161d', 'bg-header': '#0f141a', 'bg-surface': '#18202a',
    'border': '#263040', 'border-dim': '#1b232e', 'border-hover': '#3a4a5e',
    'text': '#c9d4df', 'text-dim': '#7d8a97', 'text-head': '#eef3f8', 'text-muted': '#94a1ae',
    'accent': '#4f9cf9', 'accent-dim': '#2f6db8',
  },
  states: {
    running: '#3fb950', waiting: '#d29922', failed: '#f85149', monitoring: '#58a6ff', done: '#8b949e',
    initializing: '#6e7681', idle: '#e3b341', starting: '#a371f7', complete: '#2ea043',
  },
};

const SAMPLE_HEAD = 'a'.repeat(40);
const SAMPLE_BASE = 'b'.repeat(40);

function sampleMyPr(nowMs: number, number: number, title: string, stage: MyPr['stage'], checksState: MyPr['checks']['state']): MyPr {
  return {
    key: `acme/app#${number}`, repo: 'acme/app', number, title, url: `https://github.com/acme/app/pull/${number}`,
    isDraft: false, state: 'OPEN', createdAt: new Date(nowMs - 26 * HOUR_MS).toISOString(), mergedAt: null, updatedAt: new Date(nowMs - HOUR_MS).toISOString(),
    baseRefName: 'main', baseRefOid: SAMPLE_BASE, headRefName: `sample-${number}`, isCrossRepository: false, headRefOid: SAMPLE_HEAD,
    isInMergeQueue: false, mergeMethod: 'SQUASH', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    reviewDecision: stage === 'ready' ? 'APPROVED' : 'REVIEW_REQUIRED',
    checks: { state: checksState, failing: checksState === 'FAILURE' ? ['test (ubuntu)'] : [], pendingCount: 0 },
    unresolvedThreads: 0, threads: [], reviewItems: [], behindBy: 0, reviewRequests: [], approvals: stage === 'ready' ? 1 : 0, reviews: [], stage,
  };
}

function sampleReviews(nowMs: number, frameIndex: number): ReviewsSnapshot {
  const readyPr = sampleMyPr(nowMs, 42, 'Speed up the deck import', 'ready', 'SUCCESS');
  const failingPr = sampleMyPr(nowMs, 43, 'Fix the login redirect', 'checks-failing', 'FAILURE');
  const draftPr = sampleMyPr(nowMs, 40, 'Pin the Node version', 'draft', 'SUCCESS');
  const draft: ReviewDraft = {
    requestSource: 'direct', key: 'acme/api#9', repo: 'acme/api', number: 9, title: 'Retry webhook deliveries', url: 'https://github.com/acme/api/pull/9', author: 'other-author',
    tier: 'full', reasons: ['touches webhook delivery'], reviewedHead: SAMPLE_HEAD, verdict: 'APPROVE WITH NITS', summary: 'Retries are bounded; one nit on the backoff constant.',
    body: 'Looks good. One nit inline.', comments: [{ path: 'src/webhooks.ts', line: 12, side: 'RIGHT', body: 'Name this backoff constant.' }], status: 'ready', reviewedAt: nowMs - 10 * 60 * 1000,
  };
  const queued: QueuedReview = { requestSource: 'team', key: 'acme/api#11', repo: 'acme/api', number: 11, title: 'Bump the HTTP client', url: 'https://github.com/acme/api/pull/11', author: 'sample-author' };
  const mineItem = (pr: MyPr, action: 'merge' | 'update' | null, attention: 'finished' | 'waiting' | null) => ({ source: 'mine' as const, key: `mine:${pr.key}`, prKey: pr.key, pr, stackRow: { pr, parentKey: null, depth: 0, stackSize: 1, stackHeight: 0 }, action, attention });
  const turnItems = [
    { source: 'team' as const, key: `team:${draft.key}`, prKey: draft.key, kind: 'ready' as const, review: draft, action: 'review' as const, attention: 'waiting' as const },
    mineItem(failingPr, 'update', 'waiting'),
    ...(frameIndex % 2 === 0 ? [mineItem(readyPr, 'merge', 'finished')] : []),
  ];
  return {
    groups: [
      { id: 'turn', title: 'Your turn', items: turnItems },
      { id: 'working', title: 'Agent working', items: [] },
      { id: 'queued', title: 'Queued', items: [{ source: 'team', key: `team:${queued.key}`, prKey: queued.key, kind: 'queued', review: queued, action: null, attention: null }] },
      { id: 'waiting', title: 'Waiting on others', items: [] },
      { id: 'merged', title: 'Merged', items: [] },
      { id: 'parked', title: 'Parked', items: [mineItem({ ...draftPr, isDraft: true }, null, null)] },
    ],
  };
}

export const PREVIEW_FRAME_COUNT = 6;
const PREVIEW_FRAME_MS = 5000;

export function previewSampleTopics(nowMs: number, frameIndex = 0): Omit<PackBridgeTopicData, 'theme'> {
  const isLoginBugWaiting = frameIndex % 2 === 0;
  const loginBugSinceMs = isLoginBugWaiting ? nowMs - 90 * 1000 : nowMs + frameIndex * PREVIEW_FRAME_MS - PREVIEW_FRAME_MS;
  return {
  sessions: {
    sessions: [
      { id: 'sample-1', name: 'deck import', agent: 'claude-code', state: STATES.RUNNING, stateSinceMs: nowMs - 4 * 60 * 1000, taskTitle: 'Speed up the deck import' },
      { id: 'sample-2', name: 'login bug', agent: 'codex', state: isLoginBugWaiting ? STATES.WAITING : STATES.RUNNING, stateSinceMs: loginBugSinceMs, taskTitle: 'Fix the login redirect' },
      { id: 'sample-3', name: 'docs pass', agent: 'kimi', state: STATES.FAILED, stateSinceMs: nowMs - 20 * 60 * 1000, taskTitle: null },
      { id: 'sample-4', name: 'search index', agent: 'claude-code', state: STATES.RUNNING, stateSinceMs: nowMs - 45 * 60 * 1000, taskTitle: 'Rebuild the search index' },
      { id: 'sample-5', name: 'release notes', agent: 'codex', state: STATES.COMPLETE, stateSinceMs: nowMs - 3 * HOUR_MS, taskTitle: 'Draft the release notes' },
      { id: 'sample-6', name: 'scratch', agent: null, state: STATES.IDLE, stateSinceMs: nowMs - 26 * HOUR_MS, taskTitle: null },
      { id: 'sample-7', name: 'new session', agent: 'kimi', state: STATES.STARTING, stateSinceMs: nowMs - 5 * 1000, taskTitle: null },
    ],
  },
  focus: { sessionId: 'sample-1', view: 'focus', isStreamerMode: false },
  usage: {
    planLimits: [
      { vendor: 'claude', fiveHour: { pct: 42 + frameIndex * 3, resetsAtMs: nowMs + 2 * HOUR_MS }, sevenDay: { pct: 91, resetsAtMs: nowMs + 72 * HOUR_MS } },
      { vendor: 'codex', fiveHour: { pct: 100, resetsAtMs: nowMs + HOUR_MS / 3 }, sevenDay: null },
      { vendor: 'kimi', fiveHour: { pct: null, resetsAtMs: nowMs + 4 * HOUR_MS }, sevenDay: { pct: 5, resetsAtMs: null } },
    ],
  },
  attention: { waiting: isLoginBugWaiting ? 1 : 0, finished: 1, failed: 1 },
  reviews: sampleReviews(nowMs, frameIndex),
  providers: {
    providers: [
      { url: 'https://www.githubstatus.com/api/v2/summary.json', name: 'GitHub', checkedAtMs: nowMs - 60 * 1000, error: null, incidents: [{ name: 'Degraded performance for Actions', status: 'investigating', impact: 'minor', updatedAtMs: nowMs - 12 * 60 * 1000, url: 'https://stspg.io/sample' }] },
      { url: 'https://status.claude.com/api/v2/summary.json', name: 'Claude', checkedAtMs: nowMs - 60 * 1000, error: null, incidents: [] },
    ],
  },
  };
}

type PreviewTheme = { id: string; label: string; colors: Record<string, string> };
type PreviewPanel = { id: string; label: string; url: string; reads: readonly string[] };

export function previewThemes(pack: PackOnDisk | null): PreviewTheme[] {
  const packThemes = pack?.ui?.ok ? pack.ui.value.themes.map(({ id, ...palette }) => ({ id: `${pack.header.name}/${id}`, label: palette.label, colors: themeCssColors(palette) })) : [];
  return [...packThemes, { id: 'sample-dark', label: SAMPLE_PALETTE.label, colors: themeCssColors(SAMPLE_PALETTE) }];
}

function previewPanels(pack: PackOnDisk | null): PreviewPanel[] {
  if (!pack?.ui?.ok) return [];
  return pack.ui.value.panels.map((panel) => ({ id: panel.id, label: panel.label, url: `files/${panel.entry.split('/').map(encodeURIComponent).join('/')}`, reads: panel.reads }));
}

const HOST_SCRIPT = `
const frame = document.getElementById('frame');
const panelSelect = document.getElementById('panel');
const themeSelect = document.getElementById('theme');
const status = document.getElementById('status');
const swatches = document.getElementById('swatches');
document.getElementById('report').textContent = preview.report;
let grantedTopics = [];
function addOptions(select, items) {
  for (const item of items) select.append(new Option(item.label, item.id));
}
addOptions(panelSelect, preview.panels);
panelSelect.parentElement.hidden = preview.panels.length === 0;
addOptions(themeSelect, preview.themes);
function currentPanel() {
  return preview.panels.find((panel) => panel.id === panelSelect.value);
}
let frameIndex = 0;
function topicData(topic) {
  if (topic !== 'theme') return preview.frames[frameIndex][topic];
  const theme = preview.themes.find((candidate) => candidate.id === themeSelect.value);
  return { id: theme.id, colors: theme.colors };
}
function post(message) {
  frame.contentWindow?.postMessage(message, '*');
}
function postTopic(topic) {
  post({ v: 1, kind: 'topic', topic, data: topicData(topic) });
}
function renderSwatches() {
  const theme = preview.themes.find((candidate) => candidate.id === themeSelect.value);
  for (const [property, value] of Object.entries(theme.colors)) swatches.style.setProperty(property, value);
  swatches.replaceChildren(...Object.entries(theme.colors).map(([property, value]) => {
    const swatch = document.createElement('div');
    swatch.className = 'swatch';
    swatch.style.setProperty('--swatch', 'var(' + property + ')');
    swatch.textContent = property + ' ' + value;
    return swatch;
  }));
}
function openPanel() {
  grantedTopics = [];
  const panel = currentPanel();
  frame.hidden = !panel;
  swatches.hidden = Boolean(panel);
  status.textContent = panel ? 'Waiting for the panel to subscribe.' : 'No panel to show, so here are the colors of the picked theme.';
  if (panel) frame.src = panel.url;
  if (!panel) renderSwatches();
}
const storeKey = 'glimmervoid-preview-store:' + preview.packName;
let storeWithoutStorage = {};
function savedStore() {
  try {
    return JSON.parse(localStorage.getItem(storeKey) ?? '{}');
  } catch {
    return storeWithoutStorage;
  }
}
function isShallowJsonValue(root) {
  const pending = [[root, 0]];
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    const [value, depth] = entry;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number' && Number.isFinite(value)) continue;
    if (typeof value !== 'object' || depth >= preview.storeMaxDepth) return false;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
    for (const child of Object.values(value)) pending.push([child, depth + 1]);
  }
  return true;
}
function saveStoreKey(key, value) {
  const next = Object.fromEntries(Object.entries(savedStore()).filter(([existingKey]) => existingKey !== key));
  if (value !== null) next[key] = value;
  const byteCount = new TextEncoder().encode(JSON.stringify(next) + '\\n').length;
  if (byteCount > preview.storeMaxBytes) return post({ v: 1, kind: 'store', data: savedStore(), error: preview.packName + ' would store ' + byteCount + ' bytes, over the ' + preview.storeMaxBytes + ' byte limit; nothing was saved' });
  try {
    localStorage.setItem(storeKey, JSON.stringify(next));
  } catch {
    storeWithoutStorage = next;
  }
  post({ v: 1, kind: 'store', data: next, error: null });
}
function isStoreSet(request) {
  return request && typeof request === 'object' && Object.keys(request).sort().join() === 'key,kind,v,value'
    && request.v === preview.bridgeVersion && request.kind === 'store-set' && typeof request.key === 'string' && request.key.length >= 1 && request.key.length <= 128 && isShallowJsonValue(request.value);
}
function isAction(request) {
  return request && typeof request === 'object' && request.v === preview.bridgeVersion && request.kind === 'action'
    && typeof request.id === 'string' && request.id.length >= 1 && request.id.length <= 64;
}
async function answerAction(panel, actionId, actionRequest) {
  const response = await fetch('action', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ panel: panel.id, request: actionRequest }) }).catch(() => null);
  const decision = response ? await response.json().catch(() => null) : null;
  const error = decision ? (decision.ok ? null : decision.error) : 'the preview server did not answer';
  status.textContent = error === null ? 'Glimmervoid would send ' + decision.type + ' ' + JSON.stringify(decision.payload) + '; the preview sends nothing' : 'Action not sent: ' + error;
  post({ v: 1, kind: 'action-result', id: actionId, ok: error === null, timedOut: false, result: error === null ? { ok: true, preview: true } : null, error });
}
window.addEventListener('message', (event) => {
  const panel = currentPanel();
  if (!panel || event.source !== frame.contentWindow) return;
  const request = event.data;
  if (isStoreSet(request)) return saveStoreKey(request.key, request.value);
  if (isAction(request)) return answerAction(panel, request.id, request.request);
  const isSubscribe = request && typeof request === 'object' && Object.keys(request).sort().join() === 'kind,topics,v'
    && request.v === preview.bridgeVersion && request.kind === 'subscribe' && Array.isArray(request.topics)
    && request.topics.every((topic) => preview.knownTopics.includes(topic));
  if (!isSubscribe) {
    status.textContent = 'Glimmervoid ignores this message: ' + JSON.stringify(request) + '. A subscribe is exactly { v: ' + preview.bridgeVersion + ', kind: "subscribe", topics } with topics from ' + preview.knownTopics.join(', ') + '; a store-set is exactly { v: ' + preview.bridgeVersion + ', kind: "store-set", key, value } with a key of 1 to 128 characters and a JSON value nested at most ' + preview.storeMaxDepth + ' levels deep; an action is { v: ' + preview.bridgeVersion + ', kind: "action", id, request }';
    return;
  }
  grantedTopics = request.topics.filter((topic) => panel.reads.includes(topic));
  const refused = request.topics.filter((topic) => !grantedTopics.includes(topic));
  status.textContent = 'Granted: ' + (grantedTopics.join(', ') || 'nothing') + (refused.length > 0 ? '. Not in reads, so never sent: ' + refused.join(', ') : '');
  post({ v: 1, kind: 'hello', granted: grantedTopics });
  post({ v: 1, kind: 'store', data: savedStore(), error: null });
  for (const topic of grantedTopics) postTopic(topic);
});
setInterval(() => {
  frameIndex = (frameIndex + 1) % preview.frames.length;
  for (const topic of grantedTopics.filter((granted) => granted !== 'theme')) postTopic(topic);
}, ${PREVIEW_FRAME_MS});
panelSelect.addEventListener('change', openPanel);
themeSelect.addEventListener('change', () => {
  if (grantedTopics.includes('theme')) postTopic('theme');
  if (!currentPanel()) renderSwatches();
});
openPanel();
`;

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function previewHostPage({ title, report, hasProblem, pack, nowMs }: { title: string; report: string; hasProblem: boolean; pack: PackOnDisk | null; nowMs: number }): string {
  const frames = Array.from({ length: PREVIEW_FRAME_COUNT }, (_, frameIndex) => previewSampleTopics(nowMs, frameIndex));
  const preview = { report, panels: previewPanels(pack), themes: previewThemes(pack), frames, knownTopics: PackBridgeTopic.options, bridgeVersion: PACK_BRIDGE_VERSION, packName: pack?.header.name ?? 'pack', storeMaxBytes: PACK_DATA_MAX_BYTES, storeMaxDepth: PACK_STORE_MAX_DEPTH };
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${title.replace(/[<&]/g, '')}</title>
<style>
body { margin: 0; height: 100vh; display: flex; flex-direction: column; font: 13px system-ui, sans-serif; background: #15181c; color: #d5dbe1; }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 8px 12px; border-bottom: 1px solid #2a3038; }
pre { margin: 0; padding: 8px 12px; max-height: 30vh; overflow: auto; white-space: pre-wrap; border-bottom: 1px solid #2a3038; }
#status { color: #9aa5b1; }
iframe { flex: 1; width: 100%; border: 0; }
iframe[hidden] { display: none; }
#swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 6px; padding: 12px; overflow: auto; }
#swatches[hidden] { display: none; }
.swatch { padding: 10px; border-radius: 5px; background: var(--swatch); color: #fff; text-shadow: 0 1px 2px #000; font: 12px ui-monospace, monospace; }
</style></head>
<body>
<header><strong>Pack preview</strong><label>Panel <select id="panel"></select></label><label>Theme <select id="theme"></select></label><span id="status"></span><span>Sample data that changes every 5 seconds, not your dashboard. Reload after editing the pack.</span></header>
<details${hasProblem ? ' open' : ''}><summary>Check report: ${hasProblem ? 'problems to fix' : 'no problems'}</summary><pre id="report"></pre></details>
<iframe id="frame" title="Panel" sandbox="allow-scripts allow-forms"></iframe>
<div id="swatches" hidden></div>
<script>const preview = ${scriptJson(preview)};${HOST_SCRIPT}</script>
</body></html>
`;
}
