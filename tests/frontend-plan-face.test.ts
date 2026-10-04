import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { Terminal } from '@xterm/xterm';
import type { SessionCardElement, SessionUi } from '../public/session-card/card-registry.ts';
import { preferredBorrowedFace } from '../public/session-card/face-core.ts';

class FakeClassList {
  private readonly values = new Set<string>();

  add(value: string) {
    this.values.add(value);
  }

  remove(value: string) {
    this.values.delete(value);
  }

  contains(value: string) {
    return this.values.has(value);
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList();
  readonly dataset: Record<string, string> = {};
  className = '';
  isConnected = true;
  parentElement: FakeElement | null = null;
  textContent = '';

  get nextElementSibling(): FakeElement | null {
    if (!this.parentElement) return null;
    const index = this.parentElement.children.indexOf(this);
    return this.parentElement.children[index + 1] ?? null;
  }

  appendChild(child: FakeElement) {
    if (child.parentElement) {
      const previousIndex = child.parentElement.children.indexOf(child);
      if (previousIndex !== -1) child.parentElement.children.splice(previousIndex, 1);
    }
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child: FakeElement, next: FakeElement) {
    if (child.parentElement) {
      const previousIndex = child.parentElement.children.indexOf(child);
      if (previousIndex !== -1) child.parentElement.children.splice(previousIndex, 1);
    }
    child.parentElement = this;
    const nextIndex = this.children.indexOf(next);
    if (nextIndex === -1) return this.appendChild(child);
    this.children.splice(nextIndex, 0, child);
    return child;
  }
}

test('the borrowed card swaps to plan and release restores the terminal face through the fit path', async () => {
  const elementsById = new Map<string, FakeElement>();
  elementsById.set('sessions-container', new FakeElement());
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => new FakeElement(),
      getElementById: (id: string) => elementsById.get(id) ?? null,
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { matchMedia: () => ({ matches: false }) },
  });

  const { sessionUIs } = await import('../public/session-card/card-registry.ts');
  const { borrowCard, getBorrowedCardId, releaseCard } = await import('../public/card-host.ts');
  const grid = document.getElementById('sessions-container');
  assert.ok(grid);
  const slot = document.createElement('div');
  const card = document.createElement('div') as SessionCardElement;
  grid.appendChild(card);

  let terminalWiringCount = 0;
  const activeViewerCalls: boolean[] = [];
  const button = document.createElement('button');
  const sessionUi: SessionUi = {
    term: Object.create(null) as Terminal,
    fitAddon: null,
    webglAddon: null,
    needsWebGLReload: false,
    webglAttachedWithoutLayout: false,
    dataWs: null,
    card,
    nameEl: document.createElement('span'),
    taskTitleEl: document.createElement('span'),
    taskTitle: null,
    taskTitleIsCustom: false,
    elapsedEl: document.createElement('span'),
    path: '',
    stateSince: 0,
    restartMenu: document.createElement('div'),
    termWrap: document.createElement('div'),
    btnDebug: button,
    btnRestart: button,
    btnRestartFresh: button,
    btnRestartMenu: button,
    btnResume: button,
    btnTrace: button,
    btnPlan: button,
    btnRemove: button,
    debugOverlay: null,
    debugOpen: false,
    abortController: new AbortController(),
    currentState: 'WAITING',
    face: 'terminal',
    isBorrowed: false,
    hasPlan: true,
    pendingPromptKind: 'plan',
    pendingPromptDetail: null,
    planReviewState: { reviews: [] },
    planFace: {
      el: document.createElement('section'),
      show: () => {},
      hide: () => {},
      update: () => {},
    },
  };
  sessionUi._setActiveViewer = (isActive) => { activeViewerCalls.push(isActive); };
  sessionUi._ensureTerminalReady = () => { terminalWiringCount++; };
  sessionUi._setBorrowed = (isBorrowed) => { sessionUi.isBorrowed = isBorrowed; };
  sessionUi._showPreferredFace = () => { sessionUi.face = 'plan'; };
  sessionUi._showTerminalFace = () => {
    sessionUi.face = 'terminal';
  };

  sessionUIs.set('session-a', sessionUi);
  borrowCard(sessionUi, 'session-a', slot, { className: 'focus-centered' });
  assert.equal(sessionUi.isBorrowed, true);
  assert.equal(sessionUi.face, 'plan');
  assert.equal(card.parentElement, slot);
  assert.equal(getBorrowedCardId(), 'session-a');
  assert.equal(terminalWiringCount, 1);
  assert.deepEqual(activeViewerCalls, []);

  assert.equal(releaseCard(), 'session-a');
  assert.equal(sessionUi.isBorrowed, false);
  assert.equal(sessionUi.face, 'terminal');
  assert.equal(card.parentElement, grid);
  assert.equal(getBorrowedCardId(), null);
  assert.equal(terminalWiringCount, 1);
  assert.deepEqual(activeViewerCalls, [false]);
  sessionUIs.clear();
});

test('the preferred borrowed face follows plan attention or an open review', () => {
  assert.equal(preferredBorrowedFace({ hasPlan: true, pendingPromptKind: 'plan', hasOpenReview: false }), 'plan');
  assert.equal(preferredBorrowedFace({ hasPlan: true, pendingPromptKind: null, hasOpenReview: true }), 'plan');
  assert.equal(preferredBorrowedFace({ hasPlan: false, pendingPromptKind: 'plan', hasOpenReview: true }), 'terminal');
});

test('an approved review outranks the plan prompt it answered, so the card stays on the terminal', () => {
  assert.equal(
    preferredBorrowedFace({ hasPlan: true, pendingPromptKind: 'plan', hasOpenReview: false, hasApprovedReview: true }),
    'terminal',
  );
  assert.equal(
    preferredBorrowedFace({ hasPlan: true, pendingPromptKind: 'plan', hasOpenReview: true, hasApprovedReview: true }),
    'plan',
  );
});

test('a plan summary landing after the plan prompt re-runs the one borrowed face decision', () => {
  assert.equal(preferredBorrowedFace({ hasPlan: false, pendingPromptKind: 'plan', hasOpenReview: false }), 'terminal');
  assert.equal(preferredBorrowedFace({ hasPlan: true, pendingPromptKind: 'plan', hasOpenReview: false }), 'plan');

  const lifecycleSource = fs.readFileSync(new URL('../public/session-card/lifecycle.ts', import.meta.url), 'utf8');
  const policyCalls = lifecycleSource.match(/preferredBorrowedFace\(/g) ?? [];
  assert.equal(policyCalls.length, 1, 'the borrowed face policy is consulted from one place');
  assert.match(lifecycleSource, /export function applySessionPlanChanged[\s\S]*?showPlanFaceWhenPreferred\(message\.id\)/);
  assert.match(lifecycleSource, /export function setSessionPrompt[\s\S]*?showPlanFaceWhenPreferred\(sessionId\)/);
  assert.match(lifecycleSource, /export function setSessionHasPlan[\s\S]*?showPlanFaceWhenPreferred\(sessionId\)/);
});

interface FaceEvent {
  key: string;
  shiftKey: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

class PlanFaceElement {
  children: PlanFaceElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  private readonly listenersByType = new Map<string, ((event: FaceEvent) => void)[]>();
  className = '';
  textContent = '';
  hidden = false;
  disabled = false;
  selected = false;
  type = '';
  title = '';
  value = '';
  checked = false;
  maxLength = 0;
  tabIndex = 0;
  parentElement: PlanFaceElement | null = null;
  tagName: string;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  addEventListener(type: string, listener: (event: FaceEvent) => void) {
    const listeners = this.listenersByType.get(type) ?? [];
    listeners.push(listener);
    this.listenersByType.set(type, listeners);
  }

  fire(type: string, overrides: Partial<FaceEvent> = {}) {
    if (type === 'click' && this.disabled) return;
    const event = { key: '', shiftKey: false, preventDefault: () => {}, stopPropagation: () => {}, ...overrides };
    for (const listener of this.listenersByType.get(type) ?? []) listener(event);
  }

  click() {
    this.fire('click');
  }

  focus() {
    Object.defineProperty(document, 'activeElement', { configurable: true, value: this });
  }

  append(...nodes: PlanFaceElement[]) {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  replaceChildren(...nodes: PlanFaceElement[]) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  removeAttribute(name: string) {
    delete this.attributes[name];
  }

  contains(node: unknown) {
    return node instanceof PlanFaceElement && planFaceElements(this).includes(node);
  }

  getClientRects() {
    return this.hidden ? [] : [{}];
  }

  querySelectorAll(selector: string): PlanFaceElement[] {
    return this.children.flatMap(planFaceElements).filter((node) => selector.split(',').some((part) => {
      const trimmed = part.trim();
      if (trimmed.startsWith('.')) return node.className.split(/\s+/).includes(trimmed.slice(1));
      if (trimmed.startsWith('#')) return node.getAttribute('id') === trimmed.slice(1);
      const attribute = /^\[([^=]+)="([^"]+)"\]$/.exec(trimmed);
      if (attribute) return node.getAttribute(attribute[1]) === attribute[2];
      if (trimmed === 'button:not(:disabled)') return node.tagName === 'button' && !node.disabled;
      return node.tagName === trimmed;
    }));
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

}

interface TextBearingNode {
  readonly textContent: string | null;
  readonly children: ArrayLike<TextBearingNode>;
}

function planFaceTexts(root: TextBearingNode): string[] {
  const nested = Array.from(root.children).flatMap(planFaceTexts);
  return [root.textContent ?? '', ...nested].filter((text) => text.length > 0);
}

function installPlanFaceDocument() {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (tag: string) => new PlanFaceElement(tag),
      createTextNode: (text: string) => Object.assign(new PlanFaceElement('#text'), { textContent: text }),
    },
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 0 });
}

const exploreReview = {
  agentId: 'sub-1',
  agentType: 'Explore',
  revisions: [{ revision: 1, receivedAt: 30, chars: 14, title: 'Explore plan' }],
  state: 'closed' as const,
  openRevision: null,
  approvedRevision: 1,
  lastDecision: null,
};

const openMainReview = {
  agentId: null,
  agentType: null,
  revisions: [{ revision: 2, receivedAt: 40, chars: 10, title: 'Ship it' }],
  state: 'open' as const,
  openRevision: { revision: 2, since: 40 },
  approvedRevision: null,
  lastDecision: null,
};

function planFaceButtons(root: unknown): PlanFaceElement[] {
  if (!(root instanceof PlanFaceElement)) return [];
  const nested = root.children.flatMap(planFaceButtons);
  return root.tagName === 'button' ? [root, ...nested] : nested;
}

function planFaceElements(root: unknown): PlanFaceElement[] {
  if (!(root instanceof PlanFaceElement)) return [];
  return [root, ...root.children.flatMap(planFaceElements)];
}

function byClass(root: unknown, className: string): PlanFaceElement[] {
  return planFaceElements(root).filter((node) => node.className.split(/\s+/).includes(className));
}

function onlyByClass(root: unknown, className: string): PlanFaceElement {
  const found = byClass(root, className);
  if (found.length !== 1) throw new Error(`expected one .${className}, found ${found.length}`);
  return found[0];
}

function decisionButton(root: unknown, kind: string): PlanFaceElement {
  const found = planFaceButtons(root).find((button) => button.dataset.decision === kind);
  if (!found) throw new Error(`no ${kind} action button`);
  return found;
}

function modeButton(root: unknown, mode: string): PlanFaceElement {
  const button = byClass(root, 'plan-mode').find((candidate) => candidate.dataset.mode === mode);
  if (!button) throw new Error(`no ${mode} mode`);
  return button;
}

function selectRevision(root: unknown, revision: number) {
  const button = byClass(root, 'plan-revision-option').find((candidate) => candidate.dataset.revision === String(revision));
  assert.ok(button);
  button.fire('click');
}

function saveComment(root: unknown, text: string) {
  onlyByClass(root, 'plan-comment-input').value = text;
  onlyByClass(root, 'plan-comment-save').fire('click');
}

async function loadedSectionedFace(id: string, plan = SECTIONED_PLAN) {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);
  face.show(id);
  face.update({ response: { id, reviews: [openMainReview], body: { agentId: null, revision: 2, plan, planFilePath: '/plans/a.md', receivedAt: 40 } } });
  test.after(() => dropPlanBodyCache(id));
  return { face, harness };
}

test('a shown plan face asks for the review index, then for the one body the index names', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const requests: { id: string; agentId: string | null; revision: number | undefined }[] = [];
  const face = createPlanFace({
    requestPlan: (id, agentId, revision) => { requests.push({ id, agentId, revision }); return true; },
    requestDraft: () => true,
    showTerminal: () => {},
    sendDecision: () => true,
    reportProblem: () => {},
  });

  face.show('session-index');
  assert.deepEqual(requests, [{ id: 'session-index', agentId: null, revision: undefined }]);

  face.update({ response: { id: 'session-index', reviews: [exploreReview], body: null } });
  assert.deepEqual(requests.at(-1), { id: 'session-index', agentId: 'sub-1', revision: 1 });

  face.update({
    response: {
      id: 'session-index',
      reviews: [exploreReview],
      body: { agentId: 'sub-1', revision: 1, plan: '# Explore plan', planFilePath: '/plans/a.md', receivedAt: 30 },
    },
  });
  assert.equal(requests.length, 2, 'a body already in hand is never asked for again');
  dropPlanBodyCache('session-index');
});

test('a reply with no body stops the request loop and says the revision could not be loaded', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const requests: string[] = [];
  const face = createPlanFace({
    requestPlan: (id, agentId, revision) => { requests.push(`${id}:${agentId}:${revision}`); return true; },
    requestDraft: () => true,
    showTerminal: () => {},
    sendDecision: () => true,
    reportProblem: () => {},
  });

  face.show('session-null-body');
  face.update({ response: { id: 'session-null-body', reviews: [exploreReview], body: null } });
  const requestsAfterFirstMiss = requests.length;
  face.update({ response: { id: 'session-null-body', reviews: [exploreReview], body: null } });

  assert.equal(requests.length, requestsAfterFirstMiss, 'a second empty reply never re-asks for the same revision');
  assert.ok(planFaceTexts(face.el).includes('This plan revision could not be loaded'));
  dropPlanBodyCache('session-null-body');
});

test('an error reply and a dropped send both leave the face able to ask again', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const requests: string[] = [];
  const sending = { succeeds: false };
  const face = createPlanFace({
    requestPlan: (id, agentId, revision) => {
      if (!sending.succeeds) return false;
      requests.push(`${id}:${agentId}:${revision}`);
      return true;
    },
    requestDraft: () => true,
    showTerminal: () => {},
    sendDecision: () => true,
    reportProblem: () => {},
  });

  face.show('session-offline');
  assert.deepEqual(requests, [], 'a dropped send never reaches the server');

  face.update({ isConnected: false });
  assert.deepEqual(requests, [], 'a disconnected face never asks');

  sending.succeeds = true;
  face.update({ isConnected: true });
  assert.deepEqual(requests, ['session-offline:null:undefined'], 'reconnecting retries the request the socket dropped');

  face.update({ requestFailed: true });
  assert.ok(planFaceTexts(face.el).includes('This plan revision could not be loaded'));
  dropPlanBodyCache('session-offline');
});

test('an approve click sends one decision, then every action disables until the review changes', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const decisions: { id: string; request: Record<string, unknown> }[] = [];
  let terminalShows = 0;
  const face = createPlanFace({
    requestPlan: () => true,
    requestDraft: () => true,
    showTerminal: () => { terminalShows += 1; },
    sendDecision: (id, request) => { decisions.push({ id, request: { ...request } }); return true; },
    reportProblem: () => {},
  });

  face.show('session-approve');
  face.update({
    response: {
      id: 'session-approve',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  assert.equal(decisionButton(face.el, 'approve').disabled, false);
  assert.equal(modeButton(face.el, 'edit').disabled, false, 'the editor opens from the same guard as Approve');

  decisionButton(face.el, 'approve').fire('click');
  assert.deepEqual(decisions, [{ id: 'session-approve', request: { agentId: null, revision: 2, decision: 'approve' } }]);
  for (const kind of ['approve', 'revise', 'terminal']) {
    assert.equal(decisionButton(face.el, kind).disabled, true, `${kind} is disabled while the decision is in flight`);
  }
  assert.ok(planFaceTexts(face.el).some((text) => text.includes('Sending your decision')));
  assert.deepEqual(
    planFaceButtons(face.el).filter((button) => button.dataset.decision).map((button) => button.textContent),
    ['Answer in terminal', 'Send feedback', 'Approve'],
    'labels never change while a decision is in flight',
  );

  decisionButton(face.el, 'approve').fire('click');
  assert.equal(decisions.length, 1, 'a second click while one decision is in flight sends nothing');

  assert.equal(terminalShows, 0, 'the terminal waits for the server to confirm the approval');

  face.update({ state: { reviews: [{ ...openMainReview, state: 'decided', openRevision: null, lastDecision: 'approve' }] } });
  assert.ok(planFaceTexts(face.el).some((text) => text.includes('Approved')));
  assert.equal(terminalShows, 1, 'a confirmed approval returns the card to the terminal');

  face.update({ state: { reviews: [{ ...openMainReview, state: 'decided', openRevision: null, lastDecision: 'approve' }] } });
  assert.equal(terminalShows, 1, 'a repeated push does not switch the face again');
  dropPlanBodyCache('session-approve');
});

test('an approved review stays approved once the plan tool result closes it, and a released one never is', async () => {
  const { isApprovalConfirmed, isApprovedReview } = await import('../public/plan/plan-view-core.ts');
  const closedApproved = { ...openMainReview, state: 'closed' as const, openRevision: null, approvedRevision: 2, lastDecision: 'approve' as const };
  const closedAcceptEdits = { ...closedApproved, lastDecision: 'approve-accept-edits' as const };
  const closedReleased = { ...closedApproved, approvedRevision: null, lastDecision: 'terminal' as const };
  assert.equal(isApprovedReview(closedApproved), true);
  assert.equal(isApprovedReview(closedAcceptEdits), true);
  assert.equal(isApprovedReview(closedReleased), false);
  assert.equal(isApprovedReview({ ...closedApproved, state: 'released' as const }), false);
  assert.equal(isApprovalConfirmed({ reviews: [closedApproved] }, null), true);
  assert.equal(isApprovalConfirmed({ reviews: [closedReleased] }, null), false);
});

test('an approval first confirmed by the closing push still returns the card to the terminal', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  let terminalShows = 0;
  const face = createPlanFace({
    requestPlan: () => true,
    requestDraft: () => true,
    showTerminal: () => { terminalShows += 1; },
    sendDecision: () => true,
    reportProblem: () => {},
  });

  face.show('session-approve-closed');
  face.update({
    response: {
      id: 'session-approve-closed',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  decisionButton(face.el, 'approve').fire('click');
  assert.equal(terminalShows, 0);

  face.update({ state: { reviews: [{ ...openMainReview, state: 'closed', openRevision: null, approvedRevision: 2, lastDecision: 'approve' }] } });
  assert.equal(terminalShows, 1);
  dropPlanBodyCache('session-approve-closed');
});

test('a refused approval or sent feedback leaves the card on the plan', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  let terminalShows = 0;
  const face = createPlanFace({
    requestPlan: () => true,
    requestDraft: () => true,
    showTerminal: () => { terminalShows += 1; },
    sendDecision: () => true,
    reportProblem: () => {},
  });

  face.show('session-refused');
  face.update({
    response: {
      id: 'session-refused',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  decisionButton(face.el, 'approve').fire('click');
  face.update({ decisionRefused: true });
  face.update({ state: { reviews: [{ ...openMainReview, state: 'decided', openRevision: null, lastDecision: 'approve' }] } });
  assert.equal(terminalShows, 0, 'a refused approval never switches the face');

  face.update({ state: { reviews: [openMainReview] } });
  byClass(face.el, 'plan-section-comment')[0].fire('click');
  saveComment(face.el, 'tighten step 2');
  decisionButton(face.el, 'revise').fire('click');
  face.update({ state: { reviews: [{ ...openMainReview, state: 'decided', openRevision: null, lastDecision: 'revise' }] } });
  assert.equal(terminalShows, 0, 'feedback keeps the plan on screen for the next revision');
  dropPlanBodyCache('session-refused');
});

test('a revision that reopens the review moves the face onto it, so no decision names the revision it replaced', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const requests: { agentId: string | null; revision: number | undefined }[] = [];
  const decisions: Record<string, unknown>[] = [];
  const face = createPlanFace({
    requestPlan: (_id, agentId, revision) => { requests.push({ agentId, revision }); return true; },
    requestDraft: () => true,
    showTerminal: () => {},
    sendDecision: (_id, request) => { decisions.push({ ...request }); return true; },
    reportProblem: () => {},
  });

  face.show('session-reopen');
  face.update({
    response: {
      id: 'session-reopen',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  assert.equal(decisionButton(face.el, 'approve').disabled, false);

  const reopened = {
    ...openMainReview,
    revisions: [...openMainReview.revisions, { revision: 3, receivedAt: 50, chars: 12, title: 'Ship it again' }],
    openRevision: { revision: 3, since: 50 },
  };
  face.update({ state: { reviews: [reopened] } });
  assert.deepEqual(requests.at(-1), { agentId: null, revision: 3 }, 'the face asks for the revision that reopened the review');
  assert.equal(decisionButton(face.el, 'approve').disabled, true, 'nothing is decidable until those bytes are on screen');

  face.update({
    response: {
      id: 'session-reopen',
      reviews: [reopened],
      body: { agentId: null, revision: 3, plan: '# Ship it again', planFilePath: '/plans/a.md', receivedAt: 50 },
    },
  });
  decisionButton(face.el, 'approve').fire('click');
  assert.deepEqual(decisions, [{ agentId: null, revision: 3, decision: 'approve' }]);
  dropPlanBodyCache('session-reopen');
});

test('a refused decision re-enables the actions and pulls the review index again', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const requests: { agentId: string | null; revision: number | undefined }[] = [];
  const face = createPlanFace({
    requestPlan: (_id, agentId, revision) => { requests.push({ agentId, revision }); return true; },
    requestDraft: () => true,
    showTerminal: () => {},
    sendDecision: () => true,
    reportProblem: () => {},
  });

  face.show('session-refused');
  face.update({
    response: {
      id: 'session-refused',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  decisionButton(face.el, 'approve').fire('click');
  const requestsBeforeRefusal = requests.length;

  face.update({ decisionRefused: true });
  assert.equal(decisionButton(face.el, 'approve').disabled, false, 'a refusal hands the actions back');
  assert.deepEqual(requests.slice(requestsBeforeRefusal), [{ agentId: null, revision: 2 }]);
  dropPlanBodyCache('session-refused');
});

test('showing the face and reconnecting both pull the review index, which backpressure may have dropped', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const requests: { agentId: string | null; revision: number | undefined }[] = [];
  const face = createPlanFace({
    requestPlan: (_id, agentId, revision) => { requests.push({ agentId, revision }); return true; },
    requestDraft: () => true,
    showTerminal: () => {},
    sendDecision: () => true,
    reportProblem: () => {},
  });

  face.show('session-repair');
  assert.deepEqual(requests, [{ agentId: null, revision: undefined }], 'one request covers both the body and the index');

  face.update({
    response: {
      id: 'session-repair',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  const requestsAfterBody = requests.length;

  face.show('session-repair');
  assert.deepEqual(requests.slice(requestsAfterBody), [{ agentId: null, revision: 2 }], 'a cached body still pulls the index');

  face.update({ isConnected: false });
  face.update({ isConnected: true });
  assert.deepEqual(requests.slice(requestsAfterBody + 1), [{ agentId: null, revision: 2 }], 'a reconnect pulls the index');
  dropPlanBodyCache('session-repair');
});

test('a repair pull carries the selected review, so showing the face again never snaps back to the main plan', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const requests: { agentId: string | null; revision: number | undefined }[] = [];
  const face = createPlanFace({
    requestPlan: (_id, agentId, revision) => { requests.push({ agentId, revision }); return true; },
    requestDraft: () => true,
    showTerminal: () => {},
    sendDecision: () => true,
    reportProblem: () => {},
  });

  face.show('session-selected');
  face.update({
    response: {
      id: 'session-selected',
      reviews: [openMainReview, exploreReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  byClass(face.el, 'plan-tab')[1].fire('click');
  const requestsAfterSelect = requests.length;

  face.hide();
  face.show('session-selected');
  assert.deepEqual(requests.slice(requestsAfterSelect), [{ agentId: 'sub-1', revision: 1 }]);
  dropPlanBodyCache('session-selected');
});

test('a hidden plan face transfers no plan when the socket reconnects', async () => {
  installPlanFaceDocument();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const requests: { agentId: string | null; revision: number | undefined }[] = [];
  const face = createPlanFace({
    requestPlan: (_id, agentId, revision) => { requests.push({ agentId, revision }); return true; },
    requestDraft: () => true,
    showTerminal: () => {},
    sendDecision: () => true,
    reportProblem: () => {},
  });

  face.show('session-offscreen');
  face.update({
    response: {
      id: 'session-offscreen',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  const requestsAfterBody = requests.length;

  face.hide();
  face.update({ isConnected: false });
  face.update({ isConnected: true });
  assert.equal(requests.length, requestsAfterBody, 'a card nobody is looking at costs one reconnect nothing');

  face.show('session-offscreen');
  assert.deepEqual(requests.slice(requestsAfterBody), [{ agentId: null, revision: 2 }], 'showing it pulls the index the reconnect skipped');
  dropPlanBodyCache('session-offscreen');
});

test('a plan deep link that cannot open the plan says so', () => {
  const appSource = fs.readFileSync(new URL('../public/app.ts', import.meta.url), 'utf8');
  const planHashSource = appSource.slice(
    appSource.indexOf('function activatePlanHash'),
    appSource.indexOf('function activateLocationHash'),
  );

  assert.match(planHashSource, /if \(!showPhonePlan\(sessionId\)\) showErrorToast\('No plan is stored for this session yet'\)/);
  assert.match(planHashSource, /if \(!openPlanInFocus\(sessionId\)\) showErrorToast\('No plan is stored for this session yet'\)/);
});

const twoRevisionReview = {
  agentId: null,
  agentType: null,
  revisions: [
    { revision: 1, receivedAt: 40, chars: 10, title: 'Ship it' },
    { revision: 2, receivedAt: 50, chars: 12, title: 'Ship it again' },
  ],
  state: 'open' as const,
  openRevision: { revision: 2, since: 50 },
  approvedRevision: null,
  lastDecision: null,
};

const SECTIONED_PLAN = '# Ship it\n\nthe opening\n\n## Rollout\n\nstage it\n\n## Rollback\n\nown it\n';

function sectionedFace() {
  installPlanFaceDocument();
  const requests: { agentId: string | null; revision: number | undefined }[] = [];
  const draftRequests: (string | null)[] = [];
  const decisions: Record<string, unknown>[] = [];
  const problems: string[] = [];
  return {
    requests,
    draftRequests,
    decisions,
    problems,
    deps: {
      requestPlan: (_id: string, agentId: string | null, revision?: number) => {
        requests.push({ agentId, revision });
        return true;
      },
      requestDraft: (_id: string, agentId: string | null) => { draftRequests.push(agentId); return true; },
      showTerminal: () => {},
      sendDecision: (_id: string, request: Record<string, unknown>) => { decisions.push({ ...request }); return true; },
      reportProblem: (message: string) => { problems.push(message); },
    },
  };
}

test('inline comments appear once, mark the outline and send only comments in document order', async () => {
  const { face, harness } = await loadedSectionedFace('session-comments');
  const buttons = byClass(face.el, 'plan-section-comment');
  assert.equal(buttons.length, 3);
  assert.ok(buttons.every((button) => button.textContent === 'Comment'));
  buttons[2].fire('click');
  assert.equal(onlyByClass(face.el, 'plan-comment-label').textContent, 'Comment on Rollback');
  saveComment(face.el, ' name the owner ');
  byClass(face.el, 'plan-section-comment')[1].fire('click');
  saveComment(face.el, 'stage it behind the flag');
  assert.equal(planFaceTexts(face.el).filter((text) => text === 'name the owner').length, 1);
  assert.equal(byClass(face.el, 'plan-comment-card').length, 2);
  assert.equal(byClass(face.el, 'plan-section-comment').length, 1);
  assert.deepEqual(byClass(face.el, 'plan-heading-link').map((link) => link.dataset.commented), ['false', 'true', 'true']);
  assert.equal(decisionButton(face.el, 'approve').disabled, true);
  assert.equal(decisionButton(face.el, 'revise').disabled, false);
  decisionButton(face.el, 'approve').fire('click');
  assert.deepEqual(harness.decisions, []);
  decisionButton(face.el, 'revise').fire('click');
  assert.deepEqual(harness.decisions, [{ agentId: null, revision: 2, decision: 'revise', comments: [
    { heading: 'Rollout', comment: 'stage it behind the flag' }, { heading: 'Rollback', comment: 'name the owner' },
  ] }]);
  assert.equal('feedback' in harness.decisions[0], false);
});

test('Introduction keeps a null payload heading, supports edit, empty save and removal', async () => {
  const { face, harness } = await loadedSectionedFace('session-introduction', `a note first\n\n${SECTIONED_PLAN}`);
  byClass(face.el, 'plan-section-comment')[0].fire('click');
  assert.equal(onlyByClass(face.el, 'plan-comment-label').textContent, 'Comment on Introduction');
  saveComment(face.el, 'no rollback story anywhere');
  onlyByClass(face.el, 'plan-comment-edit').fire('click');
  assert.equal(onlyByClass(face.el, 'plan-comment-input').value, 'no rollback story anywhere');
  assert.equal(byClass(face.el, 'plan-comment-card').length, 0);
  saveComment(face.el, '   ');
  assert.equal(byClass(face.el, 'plan-comment-card').length, 0);
  assert.equal(decisionButton(face.el, 'approve').disabled, false);
  byClass(face.el, 'plan-section-comment')[0].fire('click');
  saveComment(face.el, 'try removing');
  onlyByClass(face.el, 'plan-comment-remove').fire('click');
  assert.equal(byClass(face.el, 'plan-comment-card').length, 0);
  byClass(face.el, 'plan-section-comment')[0].fire('click');
  saveComment(face.el, 'no rollback story anywhere');
  decisionButton(face.el, 'revise').fire('click');
  assert.deepEqual(harness.decisions, [{ agentId: null, revision: 2, decision: 'revise', comments: [{ heading: null, comment: 'no rollback story anywhere' }] }]);
});

test('Edit mode swaps the reading column for the markdown, and approving from it sends the edited bytes', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-editor');
  face.update({
    response: {
      id: 'session-editor',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: SECTIONED_PLAN, planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  assert.equal(byClass(face.el, 'plan-editor').length, 0, 'the reading column is what a plan face opens on');

  modeButton(face.el, 'edit').fire('click');
  const editor = onlyByClass(face.el, 'plan-editor');
  assert.equal(editor.value, SECTIONED_PLAN, 'the editor opens on the markdown of the selected revision');
  assert.equal(byClass(face.el, 'plan-section-comment').length, 0, 'the reading column stepped aside');

  editor.value = `${SECTIONED_PLAN}\n## Rollforward\n\nland it\n`;
  onlyByClass(face.el, 'plan-accept-edits-checkbox').checked = true;
  decisionButton(face.el, 'approve').fire('click');
  assert.deepEqual(harness.decisions, [{
    agentId: null,
    revision: 2,
    decision: 'approve-accept-edits',
    plan: `${SECTIONED_PLAN}\n## Rollforward\n\nland it\n`,
  }]);
  dropPlanBodyCache('session-editor');
});

test('a refused edited approval keeps the edits in the editor when Edit is chosen again', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);
  const editedPlan = `${SECTIONED_PLAN}\n## Rollforward\n\nland it\n`;

  face.show('session-editor-refused');
  face.update({
    response: {
      id: 'session-editor-refused',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: SECTIONED_PLAN, planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });

  modeButton(face.el, 'edit').fire('click');
  onlyByClass(face.el, 'plan-editor').value = editedPlan;
  decisionButton(face.el, 'approve').fire('click');
  assert.deepEqual(harness.decisions, [{ agentId: null, revision: 2, decision: 'approve', plan: editedPlan }]);

  face.update({ decisionRefused: true });
  modeButton(face.el, 'edit').fire('click');
  assert.equal(onlyByClass(face.el, 'plan-editor').value, editedPlan);

  decisionButton(face.el, 'approve').fire('click');
  assert.deepEqual(harness.decisions[1], { agentId: null, revision: 2, decision: 'approve', plan: editedPlan });
  dropPlanBodyCache('session-editor-refused');
});

test('leaving the editor sends nothing, and an untouched editor approves the bytes the server holds', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-editor-exit');
  face.update({
    response: {
      id: 'session-editor-exit',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: SECTIONED_PLAN, planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });

  modeButton(face.el, 'edit').fire('click');
  const readButton = modeButton(face.el, 'read');
  assert.equal(readButton.hidden, false);
  assert.equal(readButton.textContent, 'Read');
  readButton.fire('click');
  assert.deepEqual(harness.decisions, [], 'leaving the editor decides nothing');
  assert.equal(byClass(face.el, 'plan-editor').length, 0);
  assert.equal(modeButton(face.el, 'read').attributes['aria-checked'], 'true');

  modeButton(face.el, 'edit').fire('click');
  decisionButton(face.el, 'approve').fire('click');
  assert.deepEqual(
    harness.decisions,
    [{ agentId: null, revision: 2, decision: 'approve' }],
    'an unedited approve carries no plan, so the server echoes the bytes it received',
  );
  dropPlanBodyCache('session-editor-exit');
});

test('an editor emptied to nothing refuses the decision rather than approving the bytes the server holds', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-editor-empty');
  face.update({
    response: {
      id: 'session-editor-empty',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: SECTIONED_PLAN, planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  modeButton(face.el, 'edit').fire('click');
  onlyByClass(face.el, 'plan-editor').value = '';
  decisionButton(face.el, 'approve').fire('click');

  assert.deepEqual(harness.decisions, [], 'an emptied editor sends nothing at all');
  assert.deepEqual(harness.problems, ['the edited plan is empty, so nothing was sent']);
  assert.ok(planFaceTexts(face.el).some((text) => text.includes('the edited plan is empty, so nothing was sent')));
  assert.equal(decisionButton(face.el, 'approve').disabled, false, 'the bar stays live for the retry');

  onlyByClass(face.el, 'plan-editor').value = '# Ship it, smaller';
  decisionButton(face.el, 'approve').fire('click');
  assert.deepEqual(
    harness.decisions,
    [{ agentId: null, revision: 2, decision: 'approve', plan: '# Ship it, smaller' }],
    'the retry carries what is on screen',
  );
  dropPlanBodyCache('session-editor-empty');
});

test('a plan over the body cap, a comment over its own cap and a comment count over the wire max are all refused before sending', async () => {
  const harness = sectionedFace();
  const { PLAN_BODY_CAP_BYTES, PLAN_COMMENTS_MAX, PLAN_COMMENT_MAX_CHARS } = await import('../shared/contracts/plan-review.ts');
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-wire-limits');
  face.update({
    response: {
      id: 'session-wire-limits',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: SECTIONED_PLAN, planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });

  modeButton(face.el, 'edit').fire('click');
  onlyByClass(face.el, 'plan-editor').value = 'y'.repeat(PLAN_BODY_CAP_BYTES + 1);
  decisionButton(face.el, 'approve').fire('click');
  assert.deepEqual(harness.decisions, [], 'an oversized plan never reaches the socket');
  assert.deepEqual(harness.problems, ['the edited plan is over the plan size cap, so nothing was sent']);
  modeButton(face.el, 'read').fire('click');

  byClass(face.el, 'plan-section-comment')[1].fire('click');
  assert.equal(onlyByClass(face.el, 'plan-comment-input').maxLength, PLAN_COMMENT_MAX_CHARS);
  saveComment(face.el, 'z'.repeat(PLAN_COMMENT_MAX_CHARS + 1));
  decisionButton(face.el, 'revise').fire('click');
  assert.deepEqual(harness.decisions, [], 'an oversized comment never reaches the socket');
  assert.equal(harness.problems.at(-1), `a section comment is over ${PLAN_COMMENT_MAX_CHARS} characters, so nothing was sent`);
  assert.ok(
    planFaceTexts(face.el).some((text) => text.includes('1 comment to send')),
    'the refusal keeps the comment the carbon unit typed',
  );

  const { planLimitRefusal } = await import('../public/plan/plan-view-core.ts');
  const tooMany = Array.from({ length: PLAN_COMMENTS_MAX + 1 }, () => ({ heading: 'Rollout', comment: 'stage it' }));
  assert.equal(
    planLimitRefusal({ comments: tooMany }),
    `more than ${PLAN_COMMENTS_MAX} section comments are pending, so nothing was sent`,
  );
  assert.equal(planLimitRefusal({ comments: tooMany.slice(1), plan: '# Ship it' }), null);
  dropPlanBodyCache('session-wire-limits');
});

test('Changes mode pulls the previous revision once and renders it without moving the selection', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-diff');
  face.update({
    response: {
      id: 'session-diff',
      reviews: [twoRevisionReview],
      body: { agentId: null, revision: 2, plan: '# Ship it\n\nstage it\n', planFilePath: '/plans/a.md', receivedAt: 50 },
    },
  });
  const requestsBeforeDiff = harness.requests.length;

  const diffToggle = modeButton(face.el, 'changes');
  assert.equal(diffToggle.textContent, 'Changes');
  assert.equal(diffToggle.hidden, false);
  diffToggle.fire('click');
  assert.deepEqual(harness.requests.slice(requestsBeforeDiff), [{ agentId: null, revision: 1 }]);
  assert.ok(planFaceTexts(face.el).includes('Loading the previous revision'));

  face.update({
    response: {
      id: 'session-diff',
      reviews: [twoRevisionReview],
      body: { agentId: null, revision: 1, plan: '# Ship it\n\nland it\n', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  assert.equal(modeButton(face.el, 'changes').attributes['aria-checked'], 'true');
  assert.deepEqual(
    byClass(face.el, 'plan-diff-line').map((line) => line.className.replace('plan-diff-line ', '')),
    ['plan-diff-unchanged', 'plan-diff-unchanged', 'plan-diff-removed', 'plan-diff-added', 'plan-diff-unchanged'],
  );

  decisionButton(face.el, 'approve').fire('click');
  assert.deepEqual(
    harness.decisions,
    [{ agentId: null, revision: 2, decision: 'approve' }],
    'the diff base never becomes the revision a decision names',
  );

  modeButton(face.el, 'read').fire('click');
  assert.equal(byClass(face.el, 'plan-diff-line').length, 0);
  dropPlanBodyCache('session-diff');
});

test('the first revision offers no diff, because there is nothing behind it', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-first-diff');
  face.update({
    response: {
      id: 'session-first-diff',
      reviews: [exploreReview],
      body: { agentId: 'sub-1', revision: 1, plan: '# Explore plan', planFilePath: '/plans/a.md', receivedAt: 30 },
    },
  });
  assert.equal(modeButton(face.el, 'changes').disabled, true);
  dropPlanBodyCache('session-first-diff');
});

test('the draft chip appears only while a draft is newer than the shown revision, and shows it read-only', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-draft');
  face.update({
    response: {
      id: 'session-draft',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  const chip = onlyByClass(face.el, 'plan-draft-chip');
  assert.equal(chip.textContent, 'Peek draft');
  assert.equal(chip.hidden, true, 'no draft notice means no chip');

  face.update({ draft: { id: 'session-draft', agentId: null, planFilePath: '/plans/a.md', changedAt: 30 } });
  assert.equal(chip.hidden, true, 'a draft older than the revision on screen is not news');

  face.update({ draft: { id: 'session-draft', agentId: null, planFilePath: '/plans/a.md', changedAt: 90 } });
  assert.equal(chip.hidden, false);
  assert.deepEqual(harness.draftRequests, [], 'the chip never pulls a body nobody asked for');

  chip.fire('click');
  assert.deepEqual(harness.draftRequests, [null]);

  face.update({
    response: {
      id: 'session-draft',
      reviews: [openMainReview],
      body: { agentId: null, revision: 0, plan: '# Ship it\n\nthe draft', planFilePath: '/plans/a.md', receivedAt: 91 },
    },
  });
  assert.ok(planFaceTexts(face.el).some((text) => text === 'Draft'));
  for (const kind of ['approve', 'revise', 'terminal']) {
    assert.equal(decisionButton(face.el, kind).disabled, true, `${kind} is refused on a draft nobody submitted`);
  }
  assert.equal(chip.attributes['aria-pressed'], 'true');

  chip.fire('click');
  assert.equal(onlyByClass(face.el, 'plan-status').textContent, '');
  assert.equal(decisionButton(face.el, 'approve').disabled, false, 'leaving the draft hands the revision back');
  dropPlanBodyCache('session-draft');
});

test('a draft notice for another session never reaches this face', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-mine');
  face.update({
    response: {
      id: 'session-mine',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  face.update({ draft: { id: 'session-other', agentId: null, planFilePath: '/plans/b.md', changedAt: 900 } });
  assert.equal(onlyByClass(face.el, 'plan-draft-chip').hidden, true);
  dropPlanBodyCache('session-mine');
});

test('the inline composer captures its session, author and revision and closes on reopen', async () => {
  const { face, harness } = await loadedSectionedFace('session-comment-race');
  byClass(face.el, 'plan-section-comment')[2].fire('click');
  const openedField = onlyByClass(face.el, 'plan-comment-input');
  const openedSave = onlyByClass(face.el, 'plan-comment-save');
  openedField.value = 'name the owner';
  const reopened = { ...openMainReview, revisions: [...openMainReview.revisions, { revision: 3, receivedAt: 50, chars: 12, title: 'Next' }], openRevision: { revision: 3, since: 50 } };
  face.update({ state: { reviews: [reopened] } });
  assert.equal(byClass(face.el, 'plan-comment-composer').length, 0);
  openedSave.fire('click');
  face.update({ response: { id: 'session-comment-race', reviews: [reopened], body: { agentId: null, revision: 3, plan: SECTIONED_PLAN, planFilePath: '/plans/a.md', receivedAt: 50 } } });
  assert.equal(byClass(face.el, 'plan-comment-card').length, 0);
  assert.equal(decisionButton(face.el, 'revise').disabled, true);
  assert.deepEqual(harness.decisions, []);
  selectRevision(face.el, 2);
  assert.equal(onlyByClass(face.el, 'plan-comment-text').textContent, 'name the owner');
});

test('a revise the socket refused keeps every comment for the retry that follows', async () => {
  const harness = sectionedFace();
  const sending = { succeeds: false };
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace({
    ...harness.deps,
    sendDecision: (id: string, request: Record<string, unknown>) => {
      if (!sending.succeeds) return false;
      return harness.deps.sendDecision(id, request);
    },
  });

  face.show('session-revise-dropped');
  face.update({
    response: {
      id: 'session-revise-dropped',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: SECTIONED_PLAN, planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  byClass(face.el, 'plan-section-comment')[1].fire('click');
  saveComment(face.el, 'stage it behind the flag');

  decisionButton(face.el, 'revise').fire('click');
  assert.deepEqual(harness.decisions, [], 'a dropped send never reaches the server');
  assert.ok(
    planFaceTexts(face.el).some((text) => text.includes('1 comment to send')),
    'the comments survive a send that never left the tab',
  );

  sending.succeeds = true;
  decisionButton(face.el, 'revise').fire('click');
  const revise = {
    agentId: null,
    revision: 2,
    decision: 'revise',
    comments: [{ heading: 'Rollout', comment: 'stage it behind the flag' }],
  };
  assert.deepEqual(harness.decisions, [revise]);
  assert.ok(
    byClass(face.el, 'plan-comment-text').some((node) => node.textContent === 'stage it behind the flag'),
    'a send the server has not answered yet is no reason to forget the comment',
  );

  face.update({ decisionRefused: true });
  assert.ok(
    planFaceTexts(face.el).some((text) => text.includes('1 comment to send')),
    'a refused decision leaves the comment where the retry can find it',
  );
  decisionButton(face.el, 'revise').fire('click');
  assert.deepEqual(harness.decisions, [revise, revise], 'the retry carries the same comment');

  face.update({ state: { reviews: [{ ...openMainReview, state: 'decided' as const, openRevision: null, lastDecision: 'revise' as const }] } });
  assert.equal(
    planFaceTexts(face.el).some((text) => text.includes('comment to send')),
    false,
    'the bucket empties once the review moved off the revision the comment named',
  );
  dropPlanBodyCache('session-revise-dropped');
});

test('a body nobody asked for is cached without moving the selection, and a refusal is charged to the one request in flight', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-unmatched');
  face.update({
    response: {
      id: 'session-unmatched',
      reviews: [twoRevisionReview],
      body: { agentId: null, revision: 2, plan: '# Ship it\n\nstage it\n', planFilePath: '/plans/a.md', receivedAt: 50 },
    },
  });
  face.update({
    response: {
      id: 'session-unmatched',
      reviews: [twoRevisionReview],
      body: { agentId: null, revision: 1, plan: '# Ship it\n\nland it\n', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  assert.ok(
    planFaceTexts(face.el).some((text) => text === 'Rev 2 of 2'),
    'a revision nobody asked for never becomes the one a decision would name',
  );

  face.update({ draft: { id: 'session-unmatched', agentId: null, planFilePath: '/plans/a.md', changedAt: 90 } });
  onlyByClass(face.el, 'plan-draft-chip').fire('click');
  assert.deepEqual(harness.draftRequests, [null]);
  face.update({ response: { id: 'session-unmatched', reviews: [twoRevisionReview], body: null } });

  assert.equal(
    planFaceTexts(face.el).some((text) => text.includes('This plan revision could not be loaded')),
    false,
    'a refused draft read never reports the selected revision as unreadable',
  );
  assert.equal(
    harness.problems.at(-1),
    'the draft could not be read, so nothing was shown',
    'a refused draft says so rather than swallowing the click',
  );
  onlyByClass(face.el, 'plan-draft-chip').fire('click');
  assert.deepEqual(harness.draftRequests, [null, null], 'the chip can ask again after a refusal');
  dropPlanBodyCache('session-unmatched');
});

test('a draft refused while another request is in flight still frees the chip, never leaving it dead', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);
  face.show('session-two-pending');
  face.update({
    response: {
      id: 'session-two-pending',
      reviews: [twoRevisionReview],
      body: { agentId: null, revision: 2, plan: '# Ship it\n\nstage it\n', planFilePath: '/plans/a.md', receivedAt: 50 },
    },
  });

  selectRevision(face.el, 1);
  face.update({ draft: { id: 'session-two-pending', agentId: null, planFilePath: '/plans/a.md', changedAt: 90 } });
  onlyByClass(face.el, 'plan-draft-chip').fire('click');
  assert.deepEqual(harness.draftRequests, [null], 'the selection pull and the draft pull are both in flight');

  face.update({ response: { id: 'session-two-pending', reviews: [twoRevisionReview], body: null } });
  assert.equal(harness.problems.at(-1), 'the draft could not be read, so nothing was shown');
  onlyByClass(face.el, 'plan-draft-chip').fire('click');
  assert.deepEqual(harness.draftRequests, [null, null], 'a second request in flight never wedges the chip');
  dropPlanBodyCache('session-two-pending');
});

test('a draft notice that lands before the face is ever shown still raises the chip', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.update({ draft: { id: 'session-draft-early', agentId: null, planFilePath: '/plans/a.md', changedAt: 90 } });
  face.show('session-draft-early');
  face.update({
    response: {
      id: 'session-draft-early',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: SECTIONED_PLAN, planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });

  assert.equal(onlyByClass(face.el, 'plan-draft-chip').hidden, false, 'the notice survived a face nobody had opened yet');
  dropPlanBodyCache('session-draft-early');
});

test('a draft on screen offers no comment affordance, since a draft carries no revision to file one against', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-draft-comment');
  face.update({
    response: {
      id: 'session-draft-comment',
      reviews: [openMainReview],
      body: { agentId: null, revision: 2, plan: SECTIONED_PLAN, planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  assert.equal(byClass(face.el, 'plan-section-comment').length, 3);

  face.update({ draft: { id: 'session-draft-comment', agentId: null, planFilePath: '/plans/a.md', changedAt: 90 } });
  onlyByClass(face.el, 'plan-draft-chip').fire('click');
  face.update({
    response: {
      id: 'session-draft-comment',
      reviews: [openMainReview],
      body: { agentId: null, revision: 0, plan: `${SECTIONED_PLAN}\n## Rollforward\n\nland it\n`, planFilePath: '/plans/a.md', receivedAt: 91 },
    },
  });
  assert.ok(planFaceTexts(face.el).some((text) => text === 'Draft'));
  assert.equal(byClass(face.el, 'plan-section-comment').length, 0);
  assert.ok(planFaceTexts(face.el).includes('Rollforward'), 'the draft body still reads');

  onlyByClass(face.el, 'plan-draft-chip').fire('click');
  assert.equal(byClass(face.el, 'plan-section-comment').length, 3, 'the revision hands its affordances back');
  dropPlanBodyCache('session-draft-comment');
});

test('a draft answered after the operator moved to another agent is cached, never shown under that agent', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-draft-identity');
  face.update({
    response: {
      id: 'session-draft-identity',
      reviews: [openMainReview, exploreReview],
      body: { agentId: null, revision: 2, plan: '# Ship it', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });
  face.update({ draft: { id: 'session-draft-identity', agentId: null, planFilePath: '/plans/a.md', changedAt: 90 } });
  onlyByClass(face.el, 'plan-draft-chip').fire('click');
  assert.deepEqual(harness.draftRequests, [null]);

  byClass(face.el, 'plan-tab')[1].fire('click');
  face.update({
    response: {
      id: 'session-draft-identity',
      reviews: [openMainReview, exploreReview],
      body: { agentId: null, revision: 0, plan: '# the main draft', planFilePath: '/plans/a.md', receivedAt: 91 },
    },
  });

  assert.equal(
    planFaceTexts(face.el).some((text) => text.includes('the main draft')),
    false,
    'the draft the main review asked for never renders under the subagent review',
  );
  assert.equal(planFaceTexts(face.el).some((text) => text === 'Draft'), false);
  dropPlanBodyCache('session-draft-identity');
});

test('a diff base answered after a reopen never drags the face back onto the revision it compared against', async () => {
  const harness = sectionedFace();
  const { createPlanFace, dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  const face = createPlanFace(harness.deps);

  face.show('session-diff-identity');
  face.update({
    response: {
      id: 'session-diff-identity',
      reviews: [twoRevisionReview],
      body: { agentId: null, revision: 2, plan: '# Ship it\n\nstage it\n', planFilePath: '/plans/a.md', receivedAt: 50 },
    },
  });
  modeButton(face.el, 'changes').fire('click');
  assert.deepEqual(harness.requests.at(-1), { agentId: null, revision: 1 });

  const reopened = {
    ...twoRevisionReview,
    revisions: [...twoRevisionReview.revisions, { revision: 3, receivedAt: 60, chars: 12, title: 'Ship it again' }],
    openRevision: { revision: 3, since: 60 },
  };
  face.update({ state: { reviews: [reopened] } });
  face.update({
    response: {
      id: 'session-diff-identity',
      reviews: [reopened],
      body: { agentId: null, revision: 1, plan: '# Ship it\n\nland it\n', planFilePath: '/plans/a.md', receivedAt: 40 },
    },
  });

  assert.ok(
    planFaceTexts(face.el).some((text) => text === 'Rev 3 of 3'),
    'the face stays on the revision that reopened the review',
  );
  dropPlanBodyCache('session-diff-identity');
});


test('the accept-edits checkbox chooses the approval kind without changing its label', async () => {
  for (const isChecked of [false, true]) {
    const { face, harness } = await loadedSectionedFace(`session-checkbox-${isChecked}`);
    const checkbox = onlyByClass(face.el, 'plan-accept-edits-checkbox');
    assert.equal(checkbox.disabled, false);
    assert.equal(onlyByClass(face.el, 'plan-status').hidden, true);
    checkbox.checked = isChecked;
    decisionButton(face.el, 'approve').fire('click');
    assert.deepEqual(harness.decisions, [{ agentId: null, revision: 2, decision: isChecked ? 'approve-accept-edits' : 'approve' }]);
    assert.equal(decisionButton(face.el, 'approve').textContent, 'Approve');
    assert.equal(onlyByClass(face.el, 'plan-accept-edits').hidden, true);
    assert.equal(onlyByClass(face.el, 'plan-status').hidden, false);
    assert.equal(onlyByClass(face.el, 'plan-status').textContent, 'Sending your decision');
  }
});

test('only one inline composer opens, cancel preserves saved text and mode changes close it', async () => {
  const { face } = await loadedSectionedFace('session-composer');
  byClass(face.el, 'plan-section-comment')[0].fire('click');
  onlyByClass(face.el, 'plan-comment-input').value = 'unsaved';
  byClass(face.el, 'plan-section-comment')[0].fire('click');
  assert.equal(byClass(face.el, 'plan-comment-composer').length, 1);
  assert.equal(onlyByClass(face.el, 'plan-comment-input').value, '');
  saveComment(face.el, 'saved');
  onlyByClass(face.el, 'plan-comment-edit').fire('click');
  onlyByClass(face.el, 'plan-comment-input').value = 'replacement';
  onlyByClass(face.el, 'plan-comment-cancel').fire('click');
  assert.equal(onlyByClass(face.el, 'plan-comment-text').textContent, 'saved');
  onlyByClass(face.el, 'plan-comment-edit').fire('click');
  modeButton(face.el, 'edit').fire('click');
  assert.equal(byClass(face.el, 'plan-comment-composer').length, 0);
  modeButton(face.el, 'read').fire('click');
  assert.equal(onlyByClass(face.el, 'plan-comment-text').textContent, 'saved');
});

test('View opens an in-face dialog, Escape and Close restore its trigger and selection closes it', async () => {
  const { face } = await loadedSectionedFace('session-sheet');
  const trigger = onlyByClass(face.el, 'plan-view-button');
  const panel = onlyByClass(face.el, 'plan-view-panel');
  assert.equal(trigger.attributes['aria-haspopup'], 'dialog');
  trigger.fire('click');
  assert.equal(trigger.attributes['aria-expanded'], 'true');
  assert.equal(panel.attributes.role, 'dialog');
  assert.equal(panel.attributes['aria-modal'], 'true');
  assert.equal(onlyByClass(face.el, 'plan-tabs').attributes.role, 'radiogroup');
  assert.equal(document.activeElement, onlyByClass(face.el, 'plan-sheet-close'));
  panel.fire('keydown', { key: 'Escape' });
  assert.equal(trigger.attributes['aria-expanded'], 'false');
  assert.equal(document.activeElement, trigger);
  trigger.fire('click');
  onlyByClass(face.el, 'plan-sheet-close').fire('click');
  assert.equal(trigger.attributes['aria-expanded'], 'false');
  trigger.fire('click');
  selectRevision(face.el, 2);
  assert.equal(trigger.attributes['aria-expanded'], 'false');
  trigger.fire('click');
  byClass(face.el, 'plan-tab')[0].fire('click');
  assert.equal(trigger.attributes['aria-expanded'], 'false');
});

test('desktop stepper has constant icon labels, correct boundaries and hides a single revision', async () => {
  const { face } = await loadedSectionedFace('session-stepper');
  assert.equal(onlyByClass(face.el, 'plan-revision-stepper').hidden, true);
  face.update({ state: { reviews: [twoRevisionReview] } });
  assert.equal(onlyByClass(face.el, 'plan-revision-stepper').hidden, false);
  const previous = onlyByClass(face.el, 'plan-revision-previous');
  const next = onlyByClass(face.el, 'plan-revision-next');
  assert.equal(previous.attributes['aria-label'], 'Previous revision');
  assert.equal(next.attributes['aria-label'], 'Next revision');
  assert.equal(next.disabled, true);
  previous.fire('click');
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, false);
  assert.equal(onlyByClass(face.el, 'plan-revision-label').textContent, 'Rev 1 of 2');
  next.fire('click');
  assert.equal(onlyByClass(face.el, 'plan-revision-label').textContent, 'Rev 2 of 2');
});

test('touch selects exactly one section and keeps comment buttons out of saved and composing sections', async () => {
  const { face } = await loadedSectionedFace('session-touch');
  const sections = byClass(face.el, 'plan-section');
  sections[0].fire('click');
  assert.deepEqual(sections.map((section) => section.dataset.selected), ['true', 'false', 'false']);
  sections[1].fire('click');
  assert.deepEqual(sections.map((section) => section.dataset.selected), ['false', 'true', 'false']);
  byClass(face.el, 'plan-section-comment')[1].fire('click');
  assert.equal(byClass(face.el, 'plan-section-comment').length, 2);
  saveComment(face.el, 'saved');
  assert.equal(byClass(face.el, 'plan-section-comment').length, 2);
});

test('tab and revision changes close composers while delayed saves stay with their captured targets', async () => {
  const { face } = await loadedSectionedFace('session-comment-selection');
  face.update({ state: { reviews: [twoRevisionReview, exploreReview] } });
  byClass(face.el, 'plan-section-comment')[0].fire('click');
  const mainField = onlyByClass(face.el, 'plan-comment-input');
  const mainSave = onlyByClass(face.el, 'plan-comment-save');
  mainField.value = 'main only';
  byClass(face.el, 'plan-tab')[1].fire('click');
  assert.equal(byClass(face.el, 'plan-comment-composer').length, 0);
  mainSave.fire('click');
  assert.equal(byClass(face.el, 'plan-comment-card').length, 0);
  byClass(face.el, 'plan-tab')[0].fire('click');
  assert.equal(onlyByClass(face.el, 'plan-comment-text').textContent, 'main only');
  byClass(face.el, 'plan-section-comment')[0].fire('click');
  const openedField = onlyByClass(face.el, 'plan-comment-input');
  const openedSave = onlyByClass(face.el, 'plan-comment-save');
  openedField.value = 'revision two';
  selectRevision(face.el, 1);
  assert.equal(byClass(face.el, 'plan-comment-composer').length, 0);
  openedSave.fire('click');
  selectRevision(face.el, 2);
  assert.deepEqual(byClass(face.el, 'plan-comment-text').map((node) => node.textContent), ['main only', 'revision two']);
});


test('a response that reopens a review closes its composer and selects the new revision', async () => {
  const { face, harness } = await loadedSectionedFace('session-response-reopen');
  byClass(face.el, 'plan-section-comment')[1].fire('click');
  const reopened = { ...twoRevisionReview, revisions: [...twoRevisionReview.revisions, { revision: 3, receivedAt: 90, chars: 10, title: 'Next' }], openRevision: { revision: 3, since: 90 } };
  face.update({ response: { id: 'session-response-reopen', reviews: [reopened], body: null } });
  assert.equal(byClass(face.el, 'plan-comment-composer').length, 0);
  assert.equal(onlyByClass(face.el, 'plan-revision-label').textContent, 'Rev 3 of 3');
  assert.equal(decisionButton(face.el, 'approve').disabled, true);
  assert.deepEqual(harness.requests.at(-1), { agentId: null, revision: 3 });
});

test('a live layout change closes the shared sheet and releases the reading and decision surfaces', async () => {
  const { face } = await loadedSectionedFace('session-layout-sheet');
  const { uiState } = await import('../public/ui-state-core.ts');
  onlyByClass(face.el, 'plan-view-button').fire('click');
  uiState.dispatch('setLayout', 'phone');
  assert.equal(onlyByClass(face.el, 'plan-view-button').attributes['aria-expanded'], 'false');
  assert.equal(onlyByClass(face.el, 'plan-view-panel').attributes.role, undefined);
  uiState.dispatch('setLayout', 'desktop');
});

test('mode radios support arrow keys and keep selection and keyboard focus together', async () => {
  const { face } = await loadedSectionedFace('session-mode-keys');
  modeButton(face.el, 'read').focus();
  onlyByClass(face.el, 'plan-modes').fire('keydown', { key: 'ArrowRight' });
  assert.equal(modeButton(face.el, 'edit').attributes['aria-checked'], 'true');
  assert.equal(document.activeElement, modeButton(face.el, 'edit'));
  onlyByClass(face.el, 'plan-modes').fire('keydown', { key: 'Home' });
  assert.equal(modeButton(face.el, 'read').attributes['aria-checked'], 'true');
  assert.equal(document.activeElement, modeButton(face.el, 'read'));
});


test('a delayed inline save keeps the session captured at open after the face shows another session', async () => {
  const { face } = await loadedSectionedFace('session-comment-original');
  byClass(face.el, 'plan-section-comment')[0].fire('click');
  const field = onlyByClass(face.el, 'plan-comment-input');
  const save = onlyByClass(face.el, 'plan-comment-save');
  field.value = 'original session';
  face.show('session-comment-other');
  face.update({ response: { id: 'session-comment-other', reviews: [openMainReview], body: { agentId: null, revision: 2, plan: SECTIONED_PLAN, planFilePath: '/plans/b.md', receivedAt: 40 } } });
  save.fire('click');
  assert.equal(byClass(face.el, 'plan-comment-card').length, 0);
  face.show('session-comment-original');
  assert.equal(onlyByClass(face.el, 'plan-comment-text').textContent, 'original session');
  const { dropPlanBodyCache } = await import('../public/plan/plan-face.ts');
  dropPlanBodyCache('session-comment-other');
});


test('sheet mode clicks and asynchronous refreshes keep focus inside the dialog for Escape', async () => {
  const { face } = await loadedSectionedFace('session-sheet-focus');
  onlyByClass(face.el, 'plan-view-button').fire('click');
  modeButton(face.el, 'edit').fire('click');
  assert.equal(document.activeElement, modeButton(face.el, 'edit'));
  face.update({ isConnected: false });
  assert.equal(modeButton(face.el, 'read').tabIndex, 0);
  assert.equal(document.activeElement, onlyByClass(face.el, 'plan-sheet-close'));
  onlyByClass(face.el, 'plan-view-panel').fire('keydown', { key: 'Escape' });
  assert.equal(onlyByClass(face.el, 'plan-view-button').attributes['aria-expanded'], 'false');
});

test('a problem shown beside the accept-edits checkbox leaves it visible, so approve never sends a kind nobody sees', async () => {
  const { face, harness } = await loadedSectionedFace('session-checkbox-problem');
  modeButton(face.el, 'edit').fire('click');
  onlyByClass(face.el, 'plan-accept-edits-checkbox').checked = true;
  onlyByClass(face.el, 'plan-editor').value = '';
  decisionButton(face.el, 'approve').fire('click');
  assert.deepEqual(harness.decisions, []);
  assert.equal(onlyByClass(face.el, 'plan-accept-edits').hidden, false);
  assert.equal(onlyByClass(face.el, 'plan-accept-edits-checkbox').checked, true);
  assert.equal(onlyByClass(face.el, 'plan-status').hidden, false);
  assert.equal(onlyByClass(face.el, 'plan-status').textContent, 'the edited plan is empty, so nothing was sent');
  onlyByClass(face.el, 'plan-editor').value = '# Ship it, smaller';
  decisionButton(face.el, 'approve').fire('click');
  assert.deepEqual(harness.decisions, [{ agentId: null, revision: 2, decision: 'approve-accept-edits', plan: '# Ship it, smaller' }]);
});

test('typing in an open composer blocks approve and send until the comment is saved or cancelled', async () => {
  const { face, harness } = await loadedSectionedFace('session-composer-unsaved');
  byClass(face.el, 'plan-section-comment')[1].fire('click');
  const field = onlyByClass(face.el, 'plan-comment-input');
  field.value = 'stage it behind the flag';
  field.fire('input');
  assert.equal(onlyByClass(face.el, 'plan-comment-input'), field, 'typing never rebuilds the reading column under the cursor');
  assert.equal(decisionButton(face.el, 'approve').disabled, true);
  assert.equal(decisionButton(face.el, 'revise').disabled, true);
  assert.equal(onlyByClass(face.el, 'plan-status').textContent, 'Save or cancel the open comment first.');
  decisionButton(face.el, 'approve').fire('click');
  assert.deepEqual(harness.decisions, []);
  onlyByClass(face.el, 'plan-comment-cancel').fire('click');
  assert.equal(decisionButton(face.el, 'approve').disabled, false);
  assert.equal(onlyByClass(face.el, 'plan-status').hidden, true);
});

test('editing a saved comment blocks send until the edit is saved, so feedback never carries the stale text', async () => {
  const { face, harness } = await loadedSectionedFace('session-composer-stale');
  byClass(face.el, 'plan-section-comment')[1].fire('click');
  saveComment(face.el, 'first thought');
  onlyByClass(face.el, 'plan-comment-edit').fire('click');
  const field = onlyByClass(face.el, 'plan-comment-input');
  field.value = 'first thought';
  field.fire('input');
  assert.equal(decisionButton(face.el, 'revise').disabled, false, 'an unchanged edit is not unsaved');
  field.value = 'second thought';
  field.fire('input');
  assert.equal(decisionButton(face.el, 'revise').disabled, true);
  assert.equal(decisionButton(face.el, 'approve').disabled, true);
  decisionButton(face.el, 'revise').fire('click');
  assert.deepEqual(harness.decisions, []);
  onlyByClass(face.el, 'plan-comment-save').fire('click');
  decisionButton(face.el, 'revise').fire('click');
  assert.deepEqual(harness.decisions, [{ agentId: null, revision: 2, decision: 'revise', comments: [{ heading: 'Rollout', comment: 'second thought' }] }]);
});

test('unsaved plan edits survive reselecting Edit and a Read or Changes round trip, and reset on a selection change', async () => {
  const { face } = await loadedSectionedFace('session-editor-retained');
  face.update({ state: { reviews: [twoRevisionReview] } });
  modeButton(face.el, 'edit').fire('click');
  onlyByClass(face.el, 'plan-editor').value = '# Ship it, edited';
  modeButton(face.el, 'edit').fire('click');
  assert.equal(onlyByClass(face.el, 'plan-editor').value, '# Ship it, edited');
  modeButton(face.el, 'edit').focus();
  onlyByClass(face.el, 'plan-modes').fire('keydown', { key: 'End' });
  assert.equal(onlyByClass(face.el, 'plan-editor').value, '# Ship it, edited');
  modeButton(face.el, 'read').fire('click');
  modeButton(face.el, 'edit').fire('click');
  assert.equal(onlyByClass(face.el, 'plan-editor').value, '# Ship it, edited');
  modeButton(face.el, 'changes').fire('click');
  modeButton(face.el, 'edit').fire('click');
  assert.equal(onlyByClass(face.el, 'plan-editor').value, '# Ship it, edited');
  selectRevision(face.el, 1);
  selectRevision(face.el, 2);
  modeButton(face.el, 'edit').fire('click');
  assert.equal(onlyByClass(face.el, 'plan-editor').value, SECTIONED_PLAN);
});
