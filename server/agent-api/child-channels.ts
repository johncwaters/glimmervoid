import type { Session } from '../../session/sessions.ts';
import type { AgentReadReply, ConversationApproval } from '../../shared/contracts/session.ts';
import { describeChildEndNote, describeKeptChildAttention } from '../core/agent-api-core.ts';
import type { ChildEndCause, ChildWorktree } from '../core/agent-api-core.ts';
import { decideWake, describeQuestionNote, describeStopNote, describeWakeCapNote, describeWakeLine, drainChannel, findOwnedChild, hasWakingUnread, isWakeLineAwaitingTurnStart, isWakeableState, openChannel, postToChannel, readLastAssistantMessage, shouldPostStopNote, shouldStopNoteWake, withdrawUnreadNote } from '../core/child-channel-core.ts';
import type { AgentChannel, ChannelEntry, ChannelSide } from '../core/child-channel-core.ts';
import { errorMessage } from '../../shared/text.ts';
import { STATES } from '../../shared/states.ts';
import type { SessionState } from '../../shared/states.ts';
import { unrefTimer } from '../../shared/timer-deps.ts';
import { SUBMIT_DELAY_MS } from '../../session/core/input-delivery-core.ts';
import { AGENT_LANE_TAG } from './agent-api-context.ts';
import type { AgentApiRuntime, ChannelLink, SessionWakeBudget } from './agent-api-context.ts';
import type { AttentionNoteOrigin } from '../../shared/contracts/session.ts';
import type { OperatorWakeFacts } from '../core/wake-core.ts';


interface StateChange {
  from: SessionState;
  to: SessionState;
}

interface HookEvent {
  event: string;
  payload: Record<string, unknown>;
}

function createChildChannels(runtime: AgentApiRuntime) {
  const { listAllSessions, settleSessionCoherence, logger, setTimeoutFn, clearTimeoutFn, now, channelsByChildId, linksByChildId, parentsWithChannelCleanup, sessionsWithOperatorWatch, wakeBudgetBySession, childIdsToDiscard, endCauseByChildId } = runtime;

  function noteEndCause(childId: string, cause: ChildEndCause): void {
    if (!endCauseByChildId.has(childId)) endCauseByChildId.set(childId, cause);
  }

  function forgetLink(childId: string): void {
    const link = linksByChildId.get(childId);
    if (link) for (const timer of link.retryTimersBySide.values()) clearTimeoutFn(timer);
    linksByChildId.delete(childId);
    channelsByChildId.delete(childId);
  }

  function forgetChannelsOf(parent: Session): void {
    for (const [childId, channel] of channelsByChildId) {
      if (channel.parentId === parent.id) forgetLink(childId);
    }
  }

  function recipientOf(link: ChannelLink, side: ChannelSide): Session {
    return side === 'toParent' ? link.parent : link.child;
  }

  function scheduleWakeRetry(childId: string, link: ChannelLink, side: ChannelSide, retryInMs: number): void {
    const earlierTimer = link.retryTimersBySide.get(side);
    if (earlierTimer) clearTimeoutFn(earlierTimer);
    link.retryTimersBySide.set(side, unrefTimer(setTimeoutFn(() => {
      link.retryTimersBySide.delete(side);
      wakeRecipient(childId, side);
    }, retryInMs)));
  }

  const wakeLineSubmittedAtBySession = new WeakMap<Session, number | null>();
  const turnStartListenerBySession = new WeakMap<Session, (change: StateChange) => void>();

  function releaseWakeLine(session: Session): void {
    wakeLineSubmittedAtBySession.delete(session);
    const turnStartListener = turnStartListenerBySession.get(session);
    if (!turnStartListener) return;
    session.off('state-change', turnStartListener);
    turnStartListenerBySession.delete(session);
  }

  function holdWakeLineUntilTurnStart(session: Session): void {
    releaseWakeLine(session);
    wakeLineSubmittedAtBySession.set(session, now());
    const turnStartListener = ({ to }: StateChange) => {
      if (isWakeableState(to)) return;
      releaseWakeLine(session);
    };
    turnStartListenerBySession.set(session, turnStartListener);
    session.on('state-change', turnStartListener);
  }

  function wakeBudgetOf(session: Session): SessionWakeBudget {
    const existingBudget = wakeBudgetBySession.get(session);
    if (existingBudget) return existingBudget;
    const freshBudget: SessionWakeBudget = { lastOperatorInputAt: Number.NEGATIVE_INFINITY, wakesSinceOperatorInput: 0, isOperatorFlagged: false };
    wakeBudgetBySession.set(session, freshBudget);
    return freshBudget;
  }

  function operatorWakeFactsOf(session: Session): OperatorWakeFacts {
    const budget = wakeBudgetOf(session);
    return { isOperatorFlagged: budget.isOperatorFlagged, wakesSinceOperatorInput: budget.wakesSinceOperatorInput, msSinceOperatorInput: now() - budget.lastOperatorInputAt };
  }

  function flagWakeCap(session: Session, origin: AttentionNoteOrigin, note: string): void {
    wakeBudgetOf(session).isOperatorFlagged = true;
    session.raiseAttention(origin, note);
  }

  function isWakeLineInFlight(session: Session): boolean {
    const submittedAt = wakeLineSubmittedAtBySession.get(session);
    if (submittedAt === undefined) return false;
    if (submittedAt === null) return true;
    if (isWakeLineAwaitingTurnStart(session.state, now() - submittedAt)) return true;
    releaseWakeLine(session);
    return false;
  }

  function submitWakeLine(recipient: Session, line: string, onSettled: (isSubmitted: boolean) => void): boolean {
    if (isWakeLineInFlight(recipient)) return false;
    const delivered = recipient.deliver(line, {
      when: 'idle',
      submit: true,
      onSettled: (settlement) => {
        const isSubmitted = settlement === 'submitted';
        if (!isSubmitted) {
          releaseWakeLine(recipient);
          onSettled(false);
          return;
        }
        holdWakeLineUntilTurnStart(recipient);
        wakeBudgetOf(recipient).wakesSinceOperatorInput += 1;
        onSettled(true);
      },
    });
    if (!delivered.ok) return false;
    wakeLineSubmittedAtBySession.set(recipient, null);
    return true;
  }

  function typeWakeLine(childId: string, link: ChannelLink, channel: AgentChannel, side: ChannelSide, recipient: Session): void {
    if (!submitWakeLine(recipient, describeWakeLine(channel, side), () => link.pendingWakeSides.delete(side))) {
      scheduleWakeRetry(childId, link, side, SUBMIT_DELAY_MS);
      return;
    }
    link.pendingWakeSides.add(side);
  }

  function wakeRecipient(childId: string, side: ChannelSide): void {
    const link = linksByChildId.get(childId);
    const channel = channelsByChildId.get(childId);
    if (!link || !channel) return;
    const recipient = recipientOf(link, side);
    if (recipient._destroyed) return;
    if (isWakeLineInFlight(recipient) && !link.pendingWakeSides.has(side)) {
      scheduleWakeRetry(childId, link, side, SUBMIT_DELAY_MS);
      return;
    }
    const decision = decideWake({
      recipientState: recipient.state,
      hasUnread: hasWakingUnread(channel[side]),
      isWakePending: link.pendingWakeSides.has(side),
      ...operatorWakeFactsOf(recipient),
    });
    switch (decision.kind) {
      case 'none':
        return;
      case 'hold':
        scheduleWakeRetry(childId, link, side, decision.retryInMs);
        return;
      case 'flag-operator':
        flagWakeCap(recipient, 'child-wake-cap', describeWakeCapNote(channel));
        return;
      case 'wake':
        typeWakeLine(childId, link, channel, side, recipient);
        return;
    }
  }

  function watchOperatorInput(session: Session): void {
    if (sessionsWithOperatorWatch.has(session)) return;
    sessionsWithOperatorWatch.add(session);
    session.on('operator-input', () => {
      const budget = wakeBudgetOf(session);
      budget.lastOperatorInputAt = now();
      budget.wakesSinceOperatorInput = 0;
      budget.isOperatorFlagged = false;
    });
  }

  function withdrawWaitingStopNote(childId: string, link: ChannelLink): void {
    const channel = channelsByChildId.get(childId);
    if (!channel || link.waitingStopNoteText === null) return;
    channelsByChildId.set(childId, withdrawUnreadNote(channel, 'toParent', link.waitingStopNoteText));
    link.waitingStopNoteText = null;
  }

  function watchChild(link: ChannelLink, childId: string): void {
    let lastRelayedQuestionId: ConversationApproval['requestId'] | null = null;
    link.child.on('conversation-change', ({ conversationApproval }: { conversationApproval: ConversationApproval | null }) => {
      if (conversationApproval?.kind !== 'question' || conversationApproval.requestId === lastRelayedQuestionId) return;
      lastRelayedQuestionId = conversationApproval.requestId;
      withdrawWaitingStopNote(childId, link);
      const text = describeQuestionNote(link.child.name, childId, conversationApproval);
      post(childId, 'toParent', { author: 'glimmervoid', text, at: now(), wakes: true });
    });
    link.child.on('hook-event', ({ event, payload }: HookEvent) => {
      if (event.toLowerCase() !== 'stop') return;
      link.lastChildMessage = readLastAssistantMessage(payload);
    });
    link.child.on('state-change', ({ from, to }: StateChange) => {
      const isHeldQuestionWaiting = to === STATES.WAITING && link.child._conversationApproval?.kind === 'question';
      if (!isHeldQuestionWaiting && shouldPostStopNote(from, to)) {
        const text = describeStopNote({ childName: link.child.name, state: to, lastMessage: link.lastChildMessage });
        post(childId, 'toParent', { author: 'glimmervoid', text, at: now(), wakes: shouldStopNoteWake(to, link.hasParentRead) });
        link.lastChildMessage = null;
        link.waitingStopNoteText = to === STATES.WAITING ? text : null;
      }
      wakeRecipient(childId, 'toParent');
      wakeRecipient(childId, 'toChild');
    });
  }

  function openChildChannel(parent: Session, child: Session, childName: string): () => void {
    channelsByChildId.set(child.id, openChannel({ parentId: parent.id, childId: child.id, childName }));
    const link: ChannelLink = {
      parent, child, lastChildMessage: null, waitingStopNoteText: null, hasParentRead: false, pendingWakeSides: new Set(), retryTimersBySide: new Map(),
    };
    linksByChildId.set(child.id, link);
    watchChild(link, child.id);
    watchOperatorInput(parent);
    watchOperatorInput(child);
    if (!parentsWithChannelCleanup.has(parent)) {
      parentsWithChannelCleanup.add(parent);
      parent.once('teardown', () => forgetChannelsOf(parent));
    }
    const closeChildWithParent = () => {
      noteEndCause(child.id, 'parent-ended');
      child.destroy();
    };
    const wakeParent = () => wakeRecipient(child.id, 'toParent');
    parent.on('exit', closeChildWithParent);
    parent.on('teardown', closeChildWithParent);
    parent.on('state-change', wakeParent);
    return () => {
      parent.off('exit', closeChildWithParent);
      parent.off('teardown', closeChildWithParent);
    };
  }

  async function keepOrDiscardChildWorktree(child: Session, worktree: ChildWorktree | null, isParentRemoved: boolean): Promise<boolean> {
    const isDiscardRequested = childIdsToDiscard.delete(child.id);
    if (isDiscardRequested || isParentRemoved) child.confirmWorkspaceWorkDiscard();
    await child.releaseCheckouts();
    if (!worktree) return false;
    await settleSessionCoherence(child.id).catch(() => {});
    if (isDiscardRequested || isParentRemoved) {
      await child.discardWorktree();
      return false;
    }
    return !(await child.discardWorktreeIfClean());
  }

  async function settleChildWorktree(
    parentId: string, child: Session, childName: string, startAttempt: Promise<unknown>, worktreeAtStart: ChildWorktree | null,
  ): Promise<void> {
    try {
      await startAttempt.catch(() => {});
      await child._awaitPendingReaps();
      const worktree = child.getWorktreeCarry();
      const registeredParent = listAllSessions().find((session) => session.id === parentId);
      const isKept = await keepOrDiscardChildWorktree(child, worktree, !registeredParent);
      const cause = endCauseByChildId.get(child.id) ?? 'operator';
      endCauseByChildId.delete(child.id);
      if (registeredParent && worktree && isKept) {
        logger.warn(`[${AGENT_LANE_TAG} ${childName}] kept a worktree with unpushed work: ${worktree.worktreeDir}`);
        registeredParent.raiseAttention('child-kept', describeKeptChildAttention(childName, worktree));
        post(child.id, 'toParent', { author: 'glimmervoid', text: describeChildEndNote(childName, cause, { kind: 'kept', worktree }), at: now(), wakes: true });
        return;
      }
      if (cause === 'parent-closed') return;
      const kind = worktree || worktreeAtStart ? 'discarded' : 'none';
      const hasParentRead = linksByChildId.get(child.id)?.hasParentRead ?? false;
      post(child.id, 'toParent', { author: 'glimmervoid', text: describeChildEndNote(childName, cause, { kind }), at: now(), wakes: !hasParentRead });
    } catch (error) {
      logger.warn(`[${AGENT_LANE_TAG} ${childName}] could not settle the worktree: ${errorMessage(error)}`);
    }
  }

  function post(childId: string, side: ChannelSide, entry: ChannelEntry): void {
    const channel = channelsByChildId.get(childId);
    if (!channel) return;
    channelsByChildId.set(childId, postToChannel(channel, side, entry));
    wakeRecipient(childId, side);
  }

  function drain(childId: string, side: ChannelSide): AgentReadReply['channels'][number] | null {
    const channel = channelsByChildId.get(childId);
    if (!channel) return null;
    const { channel: drainedChannel, drained } = drainChannel(channel, side);
    channelsByChildId.set(childId, drainedChannel);
    const link = linksByChildId.get(childId);
    if (link && side === 'toParent' && drained.entries.length > 0) link.hasParentRead = true;
    const peerId = side === 'toParent' ? channel.childId : channel.parentId;
    const peerName = side === 'toParent' ? channel.childName : (listAllSessions().find((session) => session.id === channel.parentId)?.name ?? channel.parentId);
    return {
      sessionId: peerId,
      name: peerName,
      entries: drained.entries.map(({ author, at, text }) => ({ from: author, at, text })),
      dropped: drained.droppedCount,
    };
  }

  function ownedChannels(parent: Session): AgentChannel[] {
    return [...channelsByChildId.values()].filter((channel) => channel.parentId === parent.id);
  }

  function findChildOf(parent: Session, target: string) {
    return findOwnedChild(ownedChannels(parent), parent.id, target);
  }

  return { noteEndCause, forgetLink, openChildChannel, settleChildWorktree, post, drain, ownedChannels, findChildOf, watchOperatorInput, operatorWakeFactsOf, flagWakeCap, isWakeLineInFlight, submitWakeLine };
}

type ChildChannels = ReturnType<typeof createChildChannels>;

export { createChildChannels };
export type { ChildChannels };
