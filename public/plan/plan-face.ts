import { PLAN_COMMENT_MAX_CHARS, PLAN_DRAFT_REVISION } from '#shared/contracts/plan-review.ts';
import type {
  PlanDecisionKind,
  PlanDecisionRequest,
  PlanDraftPush,
  PlanResponseFrame,
  PlanReviewState,
  PlanRevisionBody,
  PlanSectionComment,
} from '#shared/contracts/plan-review.ts';
import { el } from '../dom-helpers.ts';
import { uiState } from '../ui-state-core.ts';
import { diffPlanBodies } from './plan-diff-core.ts';
import { parsePlanMarkdown, splitPlanSections } from './plan-markdown-core.ts';
import type { PlanSection } from './plan-markdown-core.ts';
import { renderPlanBlocks, renderPlanDiff, renderPlanSections } from './plan-render.ts';
import { createPlanViewModel, currentHeadingIndex, formatRelativeAge, isApprovalConfirmed, isApprovalDecision, openRevisionFor, planLimitRefusal, previousRevisionFor } from './plan-view-core.ts';
import type { PlanActionKind, PlanDecisionExtras, PlanMode } from './plan-view-core.ts';

export type PlanResponse = PlanResponseFrame;

export interface PlanFaceUpdate {
  state?: PlanReviewState;
  response?: PlanResponse;
  draft?: PlanDraftPush;
  isConnected?: boolean;
  requestFailed?: boolean;
  decisionRefused?: boolean;
}

export interface PlanFaceDeps {
  signal?: AbortSignal;
  requestPlan: (id: string, agentId: string | null, revision?: number) => boolean;
  requestDraft: (id: string, agentId: string | null) => boolean;
  showTerminal: () => void;
  sendDecision: (id: string, request: PlanDecisionRequest) => boolean;
  reportProblem: (message: string) => void;
}

interface DecisionTarget {
  agentId: string | null;
  revision: number | null;
}

interface CommentTarget {
  bucketKey: string;
  sectionSlot: string;
}

type PlanRequestKind = 'selection' | 'diff-base' | 'draft';

interface PlanRequestTarget {
  kind: PlanRequestKind;
  agentId: string | null;
  revision: number | null;
}

interface SentComments {
  bucketKey: string;
  agentId: string | null;
  revision: number;
}

const MAX_CACHED_BODIES_PER_SESSION = 12;
const MAX_PENDING_REQUESTS = 8;
const WHOLE_PLAN_SECTION_KEY = '';
const READING_LINE_OFFSET_PX = 48;
const bodyCacheBySession = new Map<string, Map<string, string>>();

function bodyKey(agentId: string | null, revision: number) {
  return JSON.stringify([agentId, revision]);
}

function sectionKey(section: PlanSection) {
  return section.id ?? WHOLE_PLAN_SECTION_KEY;
}

function cachePlanBody(sessionId: string, body: PlanRevisionBody) {
  let sessionCache = bodyCacheBySession.get(sessionId);
  if (!sessionCache) {
    sessionCache = new Map();
    bodyCacheBySession.set(sessionId, sessionCache);
  }
  const key = bodyKey(body.agentId, body.revision);
  sessionCache.delete(key);
  sessionCache.set(key, body.plan);
  while (sessionCache.size > MAX_CACHED_BODIES_PER_SESSION) {
    const oldestKey = sessionCache.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    sessionCache.delete(oldestKey);
  }
}

export function dropPlanBodyCache(sessionId: string) {
  bodyCacheBySession.delete(sessionId);
}

function bodyFromCache(sessionId: string | null, agentId: string | null, revision: number | null) {
  if (!sessionId || revision === null) return null;
  return bodyCacheBySession.get(sessionId)?.get(bodyKey(agentId, revision)) ?? null;
}

export function createPlanFace(deps: PlanFaceDeps) {
  const root = el('section', 'plan-face');
  root.hidden = true;

  const head = el('header', 'plan-head');
  const narrowHeadingPicker = el('select', 'plan-heading-picker');
  narrowHeadingPicker.setAttribute('aria-label', 'Plan section');
  const viewPanel = el('div', 'plan-view-panel');
  const sheetHead = el('div', 'plan-sheet-head');
  const closeSheetButton = el('button', 'plan-control plan-sheet-close', String.fromCharCode(215));
  closeSheetButton.type = 'button';
  closeSheetButton.setAttribute('aria-label', 'Close');
  sheetHead.append(el('span', null, 'View'), closeSheetButton);
  const authorGroup = el('div', 'plan-view-group plan-author-group');
  const tabs = el('div', 'plan-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Plan author');
  authorGroup.append(el('span', 'plan-sheet-label', 'Author'), tabs);
  const revisionGroup = el('div', 'plan-view-group plan-revision-group');
  const revisionStepper = el('div', 'plan-revision-stepper');
  const previousRevisionButton = el('button', 'plan-control plan-revision-previous', String.fromCharCode(8249));
  previousRevisionButton.type = 'button';
  previousRevisionButton.setAttribute('aria-label', 'Previous revision');
  const nextRevisionButton = el('button', 'plan-control plan-revision-next', String.fromCharCode(8250));
  nextRevisionButton.type = 'button';
  nextRevisionButton.setAttribute('aria-label', 'Next revision');
  const revisionLabel = el('span', 'plan-revision-label');
  const revisionAge = el('span', 'plan-revision-age');
  revisionStepper.append(previousRevisionButton, revisionLabel, nextRevisionButton, revisionAge);
  const revisionList = el('div', 'plan-revision-list');
  revisionList.setAttribute('role', 'radiogroup');
  revisionList.setAttribute('aria-label', 'Revision');
  revisionGroup.append(el('span', 'plan-sheet-label', 'Revision'), revisionStepper, revisionList);
  const modeGroup = el('div', 'plan-view-group plan-mode-group');
  const modes = el('div', 'plan-modes');
  modes.setAttribute('role', 'radiogroup');
  modes.setAttribute('aria-label', 'Show');
  modeGroup.append(el('span', 'plan-sheet-label', 'Show'), modes);
  const spacer = el('div', 'plan-head-spacer');
  const draftNotice = el('div', 'plan-draft-notice');
  const draftDot = el('span', 'plan-draft-dot');
  draftDot.setAttribute('aria-hidden', 'true');
  const draftChip = el('button', 'plan-control plan-draft-chip', 'Peek draft');
  draftChip.type = 'button';
  draftNotice.append(draftDot, draftChip);
  viewPanel.append(sheetHead, authorGroup, revisionGroup, modeGroup, spacer, draftNotice);
  const viewButton = el('button', 'plan-control plan-view-button', 'View');
  viewButton.type = 'button';
  viewButton.setAttribute('aria-haspopup', 'dialog');
  viewButton.setAttribute('aria-expanded', 'false');
  const minimizeButton = el('button', 'plan-control plan-minimize-button', 'Minimize');
  minimizeButton.type = 'button';
  minimizeButton.addEventListener('click', deps.showTerminal);
  head.append(narrowHeadingPicker, viewPanel, viewButton, minimizeButton);
  const sheetBackdrop = el('div', 'plan-sheet-backdrop');

  const bodyLayout = el('div', 'plan-body-layout');
  const headingRail = el('nav', 'plan-heading-rail');
  headingRail.setAttribute('aria-label', 'Plan sections');
  const readingColumn = el('article', 'plan-reading-column');
  bodyLayout.append(headingRail, readingColumn);

  const editor = el('textarea', 'plan-editor');
  editor.setAttribute('aria-label', 'Plan markdown');
  editor.spellcheck = false;

  const actionBar = el('footer', 'plan-action-bar');
  const status = el('span', 'plan-status');
  status.setAttribute('role', 'status');
  const decisionSlot = el('div', 'plan-decision-slot');
  const acceptEditsLabel = el('label', 'plan-accept-edits');
  const acceptEditsCheckbox = el('input', 'plan-accept-edits-checkbox');
  acceptEditsCheckbox.type = 'checkbox';
  acceptEditsLabel.append(acceptEditsCheckbox, el('span', null, 'Accept edits'));
  decisionSlot.append(acceptEditsLabel, status);
  actionBar.append(decisionSlot);
  const actionButtons = new Map<PlanActionKind, HTMLButtonElement>();
  for (const [kind, label] of [['terminal', 'Answer in terminal'], ['revise', 'Send feedback'], ['approve', 'Approve']] as const) {
    const button = el('button', 'plan-action', label);
    button.type = 'button';
    button.dataset.decision = kind;
    button.addEventListener('click', () => {
      if (!button.disabled) actOn(kind);
    });
    actionButtons.set(kind, button);
    actionBar.append(button);
  }
  root.append(head, bodyLayout, actionBar, sheetBackdrop);

  let sessionId: string | null = null;
  let state: PlanReviewState = { reviews: [] };
  let selectedAgentId: string | null = null;
  let selectedRevision: number | null = null;
  let isConnected = true;
  let lastRequestKey = '';
  let failedRequestKey = '';
  let diffRequestKey = '';
  let draftRequestKey = '';
  let isDecisionInFlight = false;
  let awaitedApproval: DecisionTarget | null = null;
  let isEditing = false;
  let editorSelectionKey: string | null = null;
  let isDiffShown = false;
  let isDraftShown = false;
  let draftBody: string | null = null;
  let currentSections: PlanSection[] = [];
  let problem: string | null = null;
  let sentComments: SentComments | null = null;
  const draftChangedAtBySessionAgent = new Map<string, number>();
  const commentsByRevision = new Map<string, Map<string, string>>();
  const pendingRequestsByTarget = new Map<string, PlanRequestTarget>();
  let railLinks: HTMLButtonElement[] = [];
  let isHeadingSyncQueued = false;
  let composer: { target: CommentTarget; element: HTMLElement; field: HTMLTextAreaElement } | null = null;
  let isSheetOpen = false;

  function setSheetOpen(isOpen: boolean, shouldFocus = true) {
    isSheetOpen = isOpen;
    viewPanel.replaceChildren(...(isOpen
      ? [sheetHead, modeGroup, revisionGroup, authorGroup, draftNotice, spacer]
      : [sheetHead, authorGroup, revisionGroup, modeGroup, spacer, draftNotice]));
    tabs.setAttribute('role', isOpen ? 'radiogroup' : 'tablist');
    for (const button of tabs.querySelectorAll('button')) {
      const isSelected = button.getAttribute('aria-selected') === 'true' || button.getAttribute('aria-checked') === 'true';
      button.setAttribute('role', isOpen ? 'radio' : 'tab');
      button.removeAttribute(isOpen ? 'aria-selected' : 'aria-checked');
      button.setAttribute(isOpen ? 'aria-checked' : 'aria-selected', String(isSelected));
    }
    viewPanel.dataset.open = String(isOpen);
    sheetBackdrop.dataset.open = String(isOpen);
    viewButton.setAttribute('aria-expanded', String(isOpen));
    bodyLayout.inert = isOpen;
    actionBar.inert = isOpen;
    narrowHeadingPicker.inert = isOpen;
    viewButton.inert = isOpen;
    minimizeButton.inert = isOpen;
    if (isOpen) {
      viewPanel.setAttribute('role', 'dialog');
      viewPanel.setAttribute('aria-label', 'Plan view');
      viewPanel.setAttribute('aria-modal', 'true');
      closeSheetButton.focus();
      return;
    }
    viewPanel.removeAttribute('role');
    viewPanel.removeAttribute('aria-modal');
    if (shouldFocus) viewButton.focus();
  }

  function wireSelectionKeys(group: HTMLElement) {
    group.addEventListener('keydown', (event) => {
      const directions: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
      const direction = directions[event.key];
      if (direction === undefined && event.key !== 'Home' && event.key !== 'End') return;
      const buttons = [...group.querySelectorAll<HTMLElement>('button:not(:disabled)')];
      if (buttons.length === 0) return;
      event.preventDefault();
      const currentIndex = buttons.indexOf(document.activeElement as HTMLElement);
      let nextIndex = (currentIndex + (direction ?? 0) + buttons.length) % buttons.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = buttons.length - 1;
      const wasSheetOpen = isSheetOpen;
      buttons[nextIndex].click();
      if (wasSheetOpen && group !== modes) return;
      if (group === modes || !isSheetOpen) {
        const selected = group.querySelector<HTMLButtonElement>('[aria-checked="true"], [aria-selected="true"]');
        selected?.focus();
      }
    });
  }

  const stopWatchingLayout = uiState.subscribe((_state, changedKeys) => {
    if (!changedKeys.includes('layout') || !isSheetOpen) return;
    setSheetOpen(false, false);
  });
  deps.signal?.addEventListener('abort', stopWatchingLayout, { once: true });

  wireSelectionKeys(modes);
  wireSelectionKeys(tabs);
  wireSelectionKeys(revisionList);

  viewButton.addEventListener('click', () => setSheetOpen(!isSheetOpen));
  closeSheetButton.addEventListener('click', () => setSheetOpen(false));
  sheetBackdrop.addEventListener('click', () => setSheetOpen(false));
  viewPanel.addEventListener('keydown', (event) => {
    if (!isSheetOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setSheetOpen(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...viewPanel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      .filter((button) => button.getClientRects().length > 0 && button.tabIndex >= 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
      return;
    }
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });

  function scrollToHeading(id: string) {
    const heading = readingColumn.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    heading?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  }

  narrowHeadingPicker.addEventListener('change', () => scrollToHeading(narrowHeadingPicker.value));

  function markCurrentHeading() {
    isHeadingSyncQueued = false;
    const headings = railLinks
      .map((link) => readingColumn.querySelector<HTMLElement>(`#${CSS.escape(link.dataset.headingId ?? '')}`))
      .filter((heading) => heading !== null);
    const columnTop = readingColumn.getBoundingClientRect().top - readingColumn.scrollTop;
    const currentIndex = currentHeadingIndex({
      headingOffsets: headings.map((heading) => heading.getBoundingClientRect().top - columnTop),
      scrollTop: readingColumn.scrollTop,
      isScrolledToEnd: readingColumn.scrollTop > 0 && readingColumn.scrollTop + readingColumn.clientHeight >= readingColumn.scrollHeight - 2,
      readingLineOffset: READING_LINE_OFFSET_PX,
    });
    const currentId = currentIndex === null ? null : headings[currentIndex]?.id ?? null;
    for (const link of railLinks) {
      if (link.dataset.headingId === currentId) {
        link.setAttribute('aria-current', 'location');
        continue;
      }
      link.removeAttribute('aria-current');
    }
    if (currentId !== null) narrowHeadingPicker.value = currentId;
  }

  function queueHeadingSync() {
    if (isHeadingSyncQueued || root.hidden || railLinks.length === 0) return;
    isHeadingSyncQueued = true;
    requestAnimationFrame(markCurrentHeading);
  }

  readingColumn.addEventListener('scroll', queueHeadingSync, { passive: true });

  function leaveTransientViews() {
    composer = null;
    isEditing = false;
    isDiffShown = false;
    isDraftShown = false;
    draftBody = null;
  }

  function noteProblem(message: string) {
    problem = message;
    deps.reportProblem(message);
    render();
  }

  function selectRevision(revision: number | null) {
    selectedRevision = revision;
    problem = null;
    leaveTransientViews();
    setSheetOpen(false, isSheetOpen);
    render();
  }

  function stepRevision(direction: number) {
    const revisions = state.reviews.find((review) => review.agentId === selectedAgentId)?.revisions ?? [];
    const selectedIndex = revisions.findIndex((revision) => revision.revision === selectedRevision);
    const nextRevision = revisions[selectedIndex + direction];
    if (nextRevision) selectRevision(nextRevision.revision);
  }

  previousRevisionButton.addEventListener('click', () => stepRevision(-1));
  nextRevisionButton.addEventListener('click', () => stepRevision(1));

  function requestKeyFor(agentId: string | null, revision: number | null) {
    return `${sessionId ?? ''}:${agentId ?? 'main'}:${revision ?? 'latest'}`;
  }

  function requestKey() {
    return requestKeyFor(selectedAgentId, selectedRevision);
  }

  function commentsKeyFor(id: string | null, agentId: string | null, revision: number | null) {
    return `${id ?? ''}:${bodyKey(agentId, revision ?? 0)}`;
  }

  function selectedCommentsKey() {
    return commentsKeyFor(sessionId, selectedAgentId, selectedRevision);
  }

  function storedComments() {
    return commentsByRevision.get(selectedCommentsKey()) ?? null;
  }

  function pendingCommentCount() {
    return storedComments()?.size ?? 0;
  }

  function hasUnsavedComment() {
    if (composer === null) return false;
    const savedText = commentsByRevision.get(composer.target.bucketKey)?.get(composer.target.sectionSlot) ?? '';
    return composer.field.value.trim() !== savedText;
  }

  function orderedComments(bucketKey: string): PlanSectionComment[] {
    const stored = commentsByRevision.get(bucketKey);
    if (!stored) return [];
    const ordered: PlanSectionComment[] = [];
    for (const section of currentSections) {
      const comment = stored.get(sectionKey(section));
      if (comment) ordered.push({ heading: section.heading, comment });
    }
    return ordered;
  }

  function noteComment(target: CommentTarget, comment: string) {
    const text = comment.trim();
    const stored = commentsByRevision.get(target.bucketKey) ?? new Map<string, string>();
    commentsByRevision.set(target.bucketKey, stored);
    if (text.length === 0) stored.delete(target.sectionSlot);
    if (text.length > 0) stored.set(target.sectionSlot, text);
    if (stored.size === 0) commentsByRevision.delete(target.bucketKey);
    render();
  }

  function commentOn(section: PlanSection) {
    if (isDraftShown || isDecisionInFlight) return;
    const target: CommentTarget = { bucketKey: selectedCommentsKey(), sectionSlot: sectionKey(section) };
    const element = el('div', 'plan-comment-composer');
    const label = el('label', 'plan-comment-label', `Comment on ${section.heading ?? 'Introduction'}`);
    const field = el('textarea', 'plan-comment-input');
    field.maxLength = PLAN_COMMENT_MAX_CHARS;
    field.value = commentsByRevision.get(target.bucketKey)?.get(target.sectionSlot) ?? '';
    label.append(field);
    const composerActions = el('div', 'plan-comment-actions');
    const cancelButton = el('button', 'plan-control plan-comment-cancel', 'Cancel');
    cancelButton.type = 'button';
    const saveButton = el('button', 'plan-control plan-comment-save', 'Save comment');
    saveButton.type = 'button';
    composerActions.append(cancelButton, saveButton);
    element.append(label, composerActions);
    const openedComposer = { target, element, field };
    composer = openedComposer;
    field.addEventListener('input', refreshDecisionBar);
    cancelButton.addEventListener('click', () => {
      if (composer !== openedComposer) return;
      composer = null;
      render();
    });
    saveButton.addEventListener('click', () => {
      if (composer === openedComposer) composer = null;
      noteComment(target, field.value);
    });
    render();
    field.focus();
  }

  function commentAttachmentFor(section: PlanSection): HTMLElement | null {
    const target: CommentTarget = { bucketKey: selectedCommentsKey(), sectionSlot: sectionKey(section) };
    if (composer?.target.bucketKey === target.bucketKey && composer.target.sectionSlot === target.sectionSlot) return composer.element;
    const comment = storedComments()?.get(target.sectionSlot);
    if (!comment) return null;
    const card = el('div', 'plan-comment-card');
    const commentHead = el('div', 'plan-comment-head');
    const editButton = el('button', 'plan-control plan-comment-edit', 'Edit');
    editButton.type = 'button';
    editButton.addEventListener('click', () => commentOn(section));
    const removeButton = el('button', 'plan-control plan-comment-remove', 'Remove');
    removeButton.type = 'button';
    removeButton.disabled = isDecisionInFlight;
    editButton.disabled = isDecisionInFlight;
    removeButton.addEventListener('click', () => noteComment(target, ''));
    commentHead.append(el('span', 'plan-comment-label', 'Your comment'), editButton, removeButton);
    card.append(commentHead, el('p', 'plan-comment-text', comment));
    return card;
  }

  function submitDecision(decision: PlanDecisionKind, target: DecisionTarget, extras: PlanDecisionExtras = {}) {
    if (!sessionId || target.revision === null || isDecisionInFlight) return false;
    const refusal = planLimitRefusal(extras);
    if (refusal !== null) {
      noteProblem(refusal);
      return false;
    }
    const request: PlanDecisionRequest = { agentId: target.agentId, revision: target.revision, decision, ...extras };
    if (!deps.sendDecision(sessionId, request)) return false;
    problem = null;
    isDecisionInFlight = true;
    awaitedApproval = isApprovalDecision(decision) ? target : null;
    render();
    return true;
  }

  function editedPlanFor(readRevision: DecisionTarget): PlanDecisionExtras {
    if (!isEditing) return {};
    const edited = editor.value;
    if (edited === bodyFromCache(sessionId, readRevision.agentId, readRevision.revision)) return {};
    return { plan: edited };
  }

  function sendFeedback(readRevision: DecisionTarget) {
    const bucketKey = commentsKeyFor(sessionId, readRevision.agentId, readRevision.revision);
    const comments = orderedComments(bucketKey);
    if (comments.length === 0) return;
    const isSent = submitDecision('revise', readRevision, { comments });
    if (!isSent || readRevision.revision === null) return;
    sentComments = { bucketKey, agentId: readRevision.agentId, revision: readRevision.revision };
    render();
  }

  function actOn(kind: PlanActionKind) {
    const readRevision: DecisionTarget = { agentId: selectedAgentId, revision: selectedRevision };
    if (kind === 'revise') {
      sendFeedback(readRevision);
      return;
    }
    const isAcceptingEdits = kind === 'approve' && !acceptEditsLabel.hidden && acceptEditsCheckbox.checked;
    const decision = isAcceptingEdits ? 'approve-accept-edits' : kind;
    submitDecision(decision, readRevision, editedPlanFor(readRevision));
  }

  function selectMode(mode: PlanMode) {
    composer = null;
    isEditing = mode === 'edit';
    isDiffShown = mode === 'changes';
    if (isEditing && editorSelectionKey !== selectedCommentsKey()) {
      editor.value = bodyFromCache(sessionId, selectedAgentId, selectedRevision) ?? '';
      editorSelectionKey = selectedCommentsKey();
    }
    problem = null;
    render();
  }

  function pendingTargetKey(target: PlanRequestTarget) {
    return `${target.kind}:${requestKeyFor(target.agentId, target.revision)}`;
  }

  function notePendingRequest(target: PlanRequestTarget) {
    pendingRequestsByTarget.set(pendingTargetKey(target), target);
    while (pendingRequestsByTarget.size > MAX_PENDING_REQUESTS) {
      const oldestKey = pendingRequestsByTarget.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      pendingRequestsByTarget.delete(oldestKey);
    }
  }

  function explainsBody(target: PlanRequestTarget, body: PlanRevisionBody) {
    if (target.agentId !== body.agentId) return false;
    if (target.kind === 'draft') return body.revision === PLAN_DRAFT_REVISION;
    if (body.revision === PLAN_DRAFT_REVISION) return false;
    return target.revision === null || target.revision === body.revision;
  }

  function takePendingRequest(body: PlanRevisionBody): PlanRequestTarget | null {
    for (const [key, target] of pendingRequestsByTarget) {
      if (!explainsBody(target, body)) continue;
      pendingRequestsByTarget.delete(key);
      return target;
    }
    return null;
  }

  function takePendingDraftRequest(): PlanRequestTarget | null {
    for (const [key, target] of pendingRequestsByTarget) {
      if (target.kind !== 'draft') continue;
      pendingRequestsByTarget.delete(key);
      return target;
    }
    return null;
  }

  function takeSolePendingRequest(): PlanRequestTarget | null {
    if (pendingRequestsByTarget.size !== 1) return null;
    const only = pendingRequestsByTarget.entries().next().value;
    if (!only) return null;
    pendingRequestsByTarget.delete(only[0]);
    return only[1];
  }

  function requestSelectedBody() {
    if (!sessionId) return;
    const key = requestKey();
    if (lastRequestKey === key) return;
    if (!deps.requestPlan(sessionId, selectedAgentId, selectedRevision ?? undefined)) return;
    lastRequestKey = key;
    notePendingRequest({ kind: 'selection', agentId: selectedAgentId, revision: selectedRevision });
  }

  function refreshReviewIndex() {
    if (root.hidden) return;
    requestSelectedBody();
  }

  function diffBaseRevision() {
    return previousRevisionFor(state, selectedAgentId, selectedRevision);
  }

  function requestDiffBase(revision: number) {
    if (!sessionId) return;
    const key = requestKeyFor(selectedAgentId, revision);
    if (diffRequestKey === key) return;
    if (!deps.requestPlan(sessionId, selectedAgentId, revision)) return;
    diffRequestKey = key;
    notePendingRequest({ kind: 'diff-base', agentId: selectedAgentId, revision });
  }

  function requestDraftBody() {
    if (!sessionId) return;
    const key = `${sessionId}:${selectedAgentId ?? 'main'}`;
    if (draftRequestKey === key) return;
    if (!deps.requestDraft(sessionId, selectedAgentId)) return;
    draftRequestKey = key;
    notePendingRequest({ kind: 'draft', agentId: selectedAgentId, revision: null });
  }

  function draftNoticeKey(id: string | null, agentId: string | null) {
    return `${id ?? ''}:${agentId ?? ''}`;
  }

  function selectedReceivedAt() {
    const review = state.reviews.find((entry) => entry.agentId === selectedAgentId);
    return review?.revisions.find((entry) => entry.revision === selectedRevision)?.receivedAt ?? 0;
  }

  function isDraftNewer() {
    const changedAt = draftChangedAtBySessionAgent.get(draftNoticeKey(sessionId, selectedAgentId));
    if (changedAt === undefined) return false;
    return changedAt > selectedReceivedAt();
  }

  function toggleDraft() {
    if (isDraftShown) {
      leaveTransientViews();
      render();
      return;
    }
    composer = null;
    isEditing = false;
    isDiffShown = false;
    requestDraftBody();
    render();
  }

  draftChip.addEventListener('click', toggleDraft);

  function renderHeadingRail(sections: readonly PlanSection[]) {
    headingRail.replaceChildren();
    narrowHeadingPicker.replaceChildren();
    railLinks = [];
    for (const section of sections) {
      const headingId = section.id ?? 'plan-introduction';
      const headingLabel = section.heading ?? 'Introduction';
      const button = el('button', 'plan-heading-link', headingLabel);
      button.type = 'button';
      button.dataset.level = String(section.level);
      button.dataset.headingId = headingId;
      button.title = headingLabel;
      button.dataset.commented = String(storedComments()?.has(sectionKey(section)) === true);
      railLinks.push(button);
      button.addEventListener('click', () => scrollToHeading(headingId));
      headingRail.append(button);
      const option = el('option', null, headingLabel);
      option.value = headingId;
      narrowHeadingPicker.append(option);
    }
  }

  function renderDiffColumn(body: string) {
    const baseRevision = diffBaseRevision();
    if (baseRevision === null) {
      readingColumn.append(el('p', 'plan-loading', 'This is the first revision, so there is nothing to diff'));
      return;
    }
    const baseBody = bodyFromCache(sessionId, selectedAgentId, baseRevision);
    if (baseBody === null) {
      readingColumn.append(el('p', 'plan-loading', 'Loading the previous revision'));
      requestDiffBase(baseRevision);
      return;
    }
    const diff = diffPlanBodies(baseBody, body);
    if (diff.isTooLarge) {
      readingColumn.append(el('p', 'plan-loading', 'This diff is too large to show, so the newer revision stands alone'));
      readingColumn.append(renderPlanBlocks(parsePlanMarkdown(body)));
      return;
    }
    readingColumn.append(renderPlanDiff(diff));
  }

  function renderColumn(body: string | null) {
    readingColumn.replaceChildren();
    if (isEditing) {
      renderHeadingRail(currentSections);
      readingColumn.append(editor);
      return;
    }
    if (body === null) {
      currentSections = [];
      renderHeadingRail(currentSections);
      if (failedRequestKey === requestKey()) {
        readingColumn.append(el('p', 'plan-loading', 'This plan revision could not be loaded'));
        return;
      }
      readingColumn.append(el('p', 'plan-loading', 'Loading plan'));
      requestSelectedBody();
      return;
    }
    const blocks = parsePlanMarkdown(body);
    currentSections = splitPlanSections(blocks);
    renderHeadingRail(currentSections);
    if (isDiffShown) {
      renderDiffColumn(body);
      return;
    }
    if (isDraftShown) {
      readingColumn.append(renderPlanBlocks(blocks));
      return;
    }
    const stored = storedComments();
    readingColumn.append(renderPlanSections(currentSections, {
      hasComment: (section) => stored?.has(sectionKey(section)) === true,
      isComposing: (section) => composer?.target.bucketKey === selectedCommentsKey() && composer.target.sectionSlot === sectionKey(section),
      onComment: commentOn,
      attachmentFor: commentAttachmentFor,
    }));
  }

  function renderTabs(model: ReturnType<typeof createPlanViewModel>) {
    authorGroup.hidden = model.tabs.length < 2;
    tabs.replaceChildren();
    for (const tab of model.tabs) {
      const button = el('button', 'plan-tab', tab.label);
      button.type = 'button';
      button.setAttribute('role', isSheetOpen ? 'radio' : 'tab');
      button.setAttribute(isSheetOpen ? 'aria-checked' : 'aria-selected', String(tab.selected));
      button.tabIndex = tab.selected ? 0 : -1;
      button.addEventListener('click', () => {
        selectedAgentId = tab.agentId;
        selectedRevision = null;
        problem = null;
        lastRequestKey = '';
        failedRequestKey = '';
        diffRequestKey = '';
        draftRequestKey = '';
        leaveTransientViews();
        setSheetOpen(false, isSheetOpen);
        render();
      });
      tabs.append(button);
    }
  }

  function shownBody() {
    return isDraftShown ? draftBody : bodyFromCache(sessionId, selectedAgentId, selectedRevision);
  }

  function viewModelFor(body: string | null) {
    return createPlanViewModel({
      state,
      selectedAgentId,
      selectedRevision,
      body,
      isConnected,
      isDecisionInFlight,
      isDraft: isDraftShown,
      pendingCommentCount: pendingCommentCount(),
      hasUnsavedComment: hasUnsavedComment(),
      problem,
    });
  }

  function renderDecisionBar(model: ReturnType<typeof createPlanViewModel>) {
    status.textContent = model.status;
    status.hidden = model.status.length === 0;
    const canApprove = model.actions.some((action) => action.kind === 'approve' && action.enabled);
    acceptEditsLabel.hidden = !canApprove;
    acceptEditsCheckbox.disabled = !canApprove;
    for (const action of model.actions) {
      const button = actionButtons.get(action.kind);
      if (button) button.disabled = !action.enabled;
    }
  }

  function refreshDecisionBar() {
    renderDecisionBar(viewModelFor(shownBody()));
  }

  function render() {
    const shouldKeepSheetFocus = isSheetOpen && viewPanel.contains(document.activeElement);
    const selection = createPlanViewModel({ state, selectedAgentId, selectedRevision, body: null, isConnected });
    if (selectedAgentId !== selection.selectedAgentId || selectedRevision !== selection.selectedRevision) leaveTransientViews();
    selectedAgentId = selection.selectedAgentId;
    selectedRevision = selection.selectedRevision;
    if (editorSelectionKey !== selectedCommentsKey()) editorSelectionKey = null;
    const body = shownBody();
    const model = viewModelFor(body);

    renderTabs(model);

    const selectedIndex = model.revisions.findIndex((revision) => revision.selected);
    const selectedSummary = model.revisions[selectedIndex];
    const now = Date.now();
    revisionStepper.hidden = model.revisions.length < 2;
    revisionLabel.textContent = `Rev ${selectedIndex + 1} of ${model.revisions.length}`;
    revisionAge.textContent = selectedSummary ? formatRelativeAge(selectedSummary.receivedAt, now) : '';
    previousRevisionButton.disabled = selectedIndex <= 0;
    nextRevisionButton.disabled = selectedIndex < 0 || selectedIndex >= model.revisions.length - 1;
    revisionList.replaceChildren();
    for (const revision of [...model.revisions].reverse()) {
      const button = el('button', 'plan-revision-option');
      button.type = 'button';
      button.dataset.revision = String(revision.revision);
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(revision.selected));
      button.tabIndex = revision.selected ? 0 : -1;
      button.append(el('span', 'plan-revision-name', revision.label), el('span', 'plan-revision-age', formatRelativeAge(revision.receivedAt, now)));
      if (revision.isOpen) button.append(el('span', 'plan-revision-open', 'OPEN'));
      button.addEventListener('click', () => selectRevision(revision.revision));
      revisionList.append(button);
    }
    modes.replaceChildren();
    const selectedMode = isEditing ? 'edit' : isDiffShown ? 'changes' : 'read';
    const focusableMode = model.modes.find((mode) => mode.kind === selectedMode && mode.enabled) ?? model.modes[0];
    for (const mode of model.modes) {
      const button = el('button', 'plan-control plan-mode', mode.label);
      button.type = 'button';
      button.dataset.mode = mode.kind;
      button.disabled = !mode.enabled;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(mode.kind === selectedMode));
      button.tabIndex = mode.kind === focusableMode.kind ? 0 : -1;
      button.addEventListener('click', () => {
        if (button.disabled) return;
        selectMode(mode.kind);
        modes.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
      });
      modes.append(button);
    }
    draftNotice.hidden = !isDraftNewer() && !isDraftShown;
    draftChip.hidden = draftNotice.hidden;
    draftChip.setAttribute('aria-pressed', String(isDraftShown));
    renderDecisionBar(model);
    renderColumn(body);
    narrowHeadingPicker.disabled = railLinks.length === 0;
    queueHeadingSync();
    if (shouldKeepSheetFocus && !viewPanel.contains(document.activeElement)) closeSheetButton.focus();
  }

  function followConfirmedApproval(next: PlanReviewState) {
    if (awaitedApproval === null || !isApprovalConfirmed(next, awaitedApproval.agentId)) return;
    awaitedApproval = null;
    editorSelectionKey = null;
    deps.showTerminal();
  }

  function show(id: string) {
    composer = null;
    if (id !== sessionId) {
      awaitedApproval = null;
      isDecisionInFlight = false;
      problem = null;
      pendingRequestsByTarget.clear();
    }
    setSheetOpen(false, false);
    sessionId = id;
    root.hidden = false;
    lastRequestKey = '';
    failedRequestKey = '';
    render();
    refreshReviewIndex();
  }

  function hide() {
    composer = null;
    setSheetOpen(false, false);
    root.hidden = true;
  }

  function isForSelection(body: PlanRevisionBody, target: PlanRequestTarget) {
    if (target.kind !== 'selection') return false;
    if (body.agentId !== selectedAgentId) return false;
    if (target.revision !== null) return target.revision === selectedRevision;
    return selectedRevision === null || selectedRevision === body.revision;
  }

  function noteRefusedRequest(target: PlanRequestTarget) {
    if (target.kind === 'draft') {
      draftRequestKey = '';
      noteProblem('the draft could not be read, so nothing was shown');
      return;
    }
    if (target.kind === 'diff-base') {
      diffRequestKey = '';
      return;
    }
    failedRequestKey = requestKeyFor(target.agentId, target.revision);
  }

  function confirmSentComments(next: PlanReviewState) {
    if (sentComments === null) return;
    if (openRevisionFor(next, sentComments.agentId) === sentComments.revision) return;
    commentsByRevision.delete(sentComments.bucketKey);
    sentComments = null;
  }

  function adoptResponse(response: PlanResponse) {
    isDecisionInFlight = false;
    adoptState({ reviews: response.reviews });
    const body = response.body;
    if (!body) {
      const refused = takeSolePendingRequest() ?? takePendingDraftRequest();
      if (refused !== null) noteRefusedRequest(refused);
      return;
    }
    const target = takePendingRequest(body);
    if (body.revision === PLAN_DRAFT_REVISION) {
      draftRequestKey = '';
      if (target === null || body.agentId !== selectedAgentId) return;
      draftBody = body.plan;
      isDraftShown = true;
      return;
    }
    cachePlanBody(response.id, body);
    if (target === null || !isForSelection(body, target)) return;
    selectedAgentId = body.agentId;
    selectedRevision = body.revision;
    lastRequestKey = '';
    failedRequestKey = '';
  }

  function adoptState(next: PlanReviewState) {
    const reopenedRevision = openRevisionFor(next, selectedAgentId);
    if (reopenedRevision !== null && reopenedRevision !== openRevisionFor(state, selectedAgentId)) {
      selectedRevision = reopenedRevision;
      leaveTransientViews();
    }
    confirmSentComments(next);
    state = next;
    isDecisionInFlight = false;
    followConfirmedApproval(next);
  }

  function update(next: PlanFaceUpdate) {
    let hasReconnected = false;
    if (next.state) adoptState(next.state);
    if (next.draft) {
      draftChangedAtBySessionAgent.set(draftNoticeKey(next.draft.id, next.draft.agentId), next.draft.changedAt);
    }
    if (next.decisionRefused) {
      awaitedApproval = null;
      isDecisionInFlight = false;
      sentComments = null;
    }
    if (typeof next.isConnected === 'boolean') {
      hasReconnected = next.isConnected && !isConnected;
      isConnected = next.isConnected;
      if (hasReconnected) {
        lastRequestKey = '';
        failedRequestKey = '';
        diffRequestKey = '';
        draftRequestKey = '';
        isDecisionInFlight = false;
      }
    }
    if (next.requestFailed) failedRequestKey = lastRequestKey;
    if (next.response) adoptResponse(next.response);
    if (!root.hidden) render();
    if (hasReconnected || next.decisionRefused) refreshReviewIndex();
  }

  return { el: root, show, hide, update };
}
