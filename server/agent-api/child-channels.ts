import type { Session } from '../../session/sessions.ts';
import type { AgentReadReply, ConversationApproval } from '../../shared/contracts/session.ts';
import { describeChildEndNote, describeKeptChildAttention } from '../core/agent-api-core.ts';
import type { ChildEndCause, ChildWorktree } from '../core/agent-api-core.ts';
import { canSubmitWake, decideWake, describeQuestionNote, describeStopNote, describeWakeCapNote, describeWakeLine, drainChannel, findOwnedChild, hasWakingUnread, openChannel, postToChannel, readLastAssistantMessage, shouldPostStopNote, shouldStopNoteWake, withdrawUnreadNote } from '../core/child-channel-core.ts';
import type { AgentChannel, ChannelEntry, ChannelSide } from '../core/child-channel-core.ts';
import { errorMessage } from '../../shared/text.ts';
import { STATES } from '../../shared/states.ts';
import type { SessionState } from '../../shared/states.ts';
import { unrefTimer } from '../../shared/timer-deps.ts';
import { AGENT_LANE_TAG } from './agent-api-context.ts';
import type { AgentApiRuntime, ChannelLink } from './agent-api-context.ts';

const WAKE_SUBMIT_DELAY_MS = 150;

interface StateChange {
  from: SessionState;
  to: SessionState;
}

interface HookEvent {
  event: string;
  payload: Record<string, unknown>;
}

function createChildChannels(runtime: AgentApiRuntime) {
  const { listAllSessions, settleSessionCoherence, logger, setTimeoutFn, clearTimeoutFn, now, channelsByChildId, linksByChildId, parentsWithChannelCleanup, sessionsWithOperatorWatch, lastOperatorInputAtBySession, childIdsToDiscard, endCauseByChildId } = runtime;

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

  function typeWakeLine(link: ChannelLink, channel: AgentChannel, side: ChannelSide, recipient: Session): void {
    if (!recipient.pasteText(describeWakeLine(channel, side)).ok) return;
    const pastedAt = now();
    link.pendingWakeSides.add(side);
    unrefTimer(setTimeoutFn(() => {
      link.pendingWakeSides.delete(side);
      if (recipient._destroyed) return;
      const lastOperatorInputAt = lastOperatorInputAtBySession.get(recipient) ?? Number.NEGATIVE_INFINITY;
      if (!canSubmitWake({ recipientState: recipient.state, pastedAt, lastOperatorInputAt })) return;
      recipient.write('\r');
      link.wakesSinceOperatorInput += 1;
    }, WAKE_SUBMIT_DELAY_MS));
  }

  function wakeRecipient(childId: string, side: ChannelSide): void {
    const link = linksByChildId.get(childId);
    const channel = channelsByChildId.get(childId);
    if (!link || !channel) return;
    const recipient = recipientOf(link, side);
    if (recipient._destroyed) return;
    const decision = decideWake({
      recipientState: recipient.state,
      hasUnread: hasWakingUnread(channel[side]),
      isWakePending: link.pendingWakeSides.has(side),
      isOperatorFlagged: link.isOperatorFlagged,
      wakesSinceOperatorInput: link.wakesSinceOperatorInput,
      msSinceOperatorInput: now() - (lastOperatorInputAtBySession.get(recipient) ?? Number.NEGATIVE_INFINITY),
    });
    switch (decision.kind) {
      case 'none':
        return;
      case 'hold':
        scheduleWakeRetry(childId, link, side, decision.retryInMs);
        return;
      case 'flag-operator':
        link.isOperatorFlagged = true;
        recipient.noteAttention(describeWakeCapNote(channel));
        return;
      case 'wake':
        typeWakeLine(link, channel, side, recipient);
        return;
    }
  }

  function linksOf(session: Session): ChannelLink[] {
    return [...linksByChildId.values()].filter((link) => link.parent === session || link.child === session);
  }

  function watchOperatorInput(session: Session): void {
    if (sessionsWithOperatorWatch.has(session)) return;
    sessionsWithOperatorWatch.add(session);
    session.on('operator-input', () => {
      lastOperatorInputAtBySession.set(session, now());
      for (const link of linksOf(session)) {
        link.wakesSinceOperatorInput = 0;
        link.isOperatorFlagged = false;
      }
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
      parent, child, lastChildMessage: null, waitingStopNoteText: null, hasParentRead: false, wakesSinceOperatorInput: 0, isOperatorFlagged: false, pendingWakeSides: new Set(), retryTimersBySide: new Map(),
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
        registeredParent.noteAttention(describeKeptChildAttention(childName, worktree));
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


  return { noteEndCause, forgetLink, openChildChannel, settleChildWorktree, post, drain, ownedChannels, findChildOf };
}

type ChildChannels = ReturnType<typeof createChildChannels>;

export { createChildChannels };
export type { ChildChannels };
