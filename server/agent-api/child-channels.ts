import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Session } from '../../session/sessions.ts';
import { unreadNoticeFlagPath } from '../../detection/settings-injector.ts';
import { branchParentIdOf } from '../../shared/parent-link.ts';
import type { AgentReadReply, ConversationApproval } from '../../shared/contracts/session.ts';
import { describeChildEndNote, describeKeptChildAttention } from '../core/agent-api-core.ts';
import type { ChildEndCause, ChildWorktree } from '../core/agent-api-core.ts';
import { decideWake, describeQuestionNote, describeStopNote, describeWakeLine, drainChannelPage, findOwnedChild, findSibling, hasWakingUnread, highestWakingSeq, isWakeLineAwaitingTurnStart, matchesMailboxCursor, WAKE_TURN_START_TIMEOUT_MS, openChannel, postToChannel, quietUnread, readLastAssistantMessage, shouldPostStopNote, shouldReuseWithheldWakeLine, shouldStopNoteWake, takeSessionInTurnNotices, withdrawUnreadNote } from '../core/child-channel-core.ts';
import type { AgentChannel, ChannelEntry, ChannelKind, ChannelPageCursor, ChannelSide } from '../core/child-channel-core.ts';
import { errorMessage } from '../../shared/text.ts';
import { STATES } from '../../shared/states.ts';
import type { SessionState } from '../../shared/states.ts';
import { unrefTimer } from '../../shared/timer-deps.ts';
import type { TimerHandle } from '../../shared/timer-deps.ts';
import { SUBMIT_DELAY_MS } from '../../session/core/input-delivery-core.ts';
import { AGENT_LANE_TAG } from './agent-api-context.ts';
import type { AgentApiRuntime, ChannelLink } from './agent-api-context.ts';


interface WakeLineDelivery {
  when?: 'idle' | 'now';
}

interface StateChange {
  from: SessionState;
  to: SessionState;
  event?: string;
}

interface HookEvent {
  event: string;
  payload: Record<string, unknown>;
}

function createChildChannels(runtime: AgentApiRuntime) {
  const { listAllSessions, logger, setTimeoutFn, clearTimeoutFn, now, channelsByChildId, linksByChildId, parentsWithChannelCleanup, sessionsWithOperatorWatch, lastOperatorInputAtBySession, childIdsToDiscard, endCauseByChildId } = runtime;
  const flagSyncBySessionId = new Map<string, Promise<void>>();

  function hasAnyWakingUnreadFor(sessionId: string): boolean {
    for (const channel of channelsByChildId.values()) {
      if (channel.childId === sessionId && hasWakingUnread(channel.toChild)) return true;
      if (channel.parentId === sessionId && hasWakingUnread(channel.toParent)) return true;
    }
    return false;
  }

  function syncUnreadFlag(sessionId: string): void {
    const previous = flagSyncBySessionId.get(sessionId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const flagPath = unreadNoticeFlagPath(sessionId);
      if (hasAnyWakingUnreadFor(sessionId)) {
        await fsp.mkdir(path.dirname(flagPath), { recursive: true, mode: 0o700 });
        await fsp.writeFile(flagPath, '', { mode: 0o600 });
        return;
      }
      await fsp.unlink(flagPath).catch(() => {});
    }).catch(() => {}).finally(() => {
      if (flagSyncBySessionId.get(sessionId) === next) flagSyncBySessionId.delete(sessionId);
    });
    flagSyncBySessionId.set(sessionId, next);
  }

  function recipientIdOf(channel: AgentChannel, side: ChannelSide): string {
    return side === 'toChild' ? channel.childId : channel.parentId;
  }

  function noteEndCause(childId: string, cause: ChildEndCause): void {
    if (!endCauseByChildId.has(childId)) endCauseByChildId.set(childId, cause);
    if (endCauseByChildId.get(childId) !== 'parent-closed') return;
    const channel = channelsByChildId.get(childId);
    if (!channel) return;
    channelsByChildId.set(childId, quietUnread(channel, 'toParent'));
    syncUnreadFlag(channel.parentId);
  }

  function unlink(childId: string): void {
    const link = linksByChildId.get(childId);
    if (link) for (const timer of link.retryTimersBySide.values()) clearTimeoutFn(timer);
    link?.stopWatchingChild();
    linksByChildId.delete(childId);
  }

  function forgetLink(childId: string): void {
    const channel = channelsByChildId.get(childId);
    unlink(childId);
    channelsByChildId.delete(childId);
    if (!channel) return;
    syncUnreadFlag(channel.parentId);
    syncUnreadFlag(channel.childId);
  }

  function forgetChannelsOf(parent: Session): void {
    for (const [childId, channel] of channelsByChildId) {
      if (channel.parentId !== parent.id || linksByChildId.get(childId)?.parent !== parent) continue;
      if (channel.kind === 'branch') unlink(childId);
      if (channel.kind !== 'branch') forgetLink(childId);
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
  const turnStartListenerBySession = new WeakMap<Session, () => void>();
  const turnStartBoundTimerBySession = new WeakMap<Session, TimerHandle>();
  const wakeWaitersBySession = new WeakMap<Session, Map<string, () => void>>();
  const withheldWakeBySession = new WeakMap<Session, { line: string; pastedAt: number; onSettled: (isSubmitted: boolean) => void; clear: () => void }>();

  function clearWithheldWake(session: Session): void {
    const entry = withheldWakeBySession.get(session);
    if (!entry) return;
    withheldWakeBySession.delete(session);
    entry.clear();
  }

  function rememberWithheldWake(session: Session, line: string, pastedAt: number, onSettled: (isSubmitted: boolean) => void): void {
    clearWithheldWake(session);
    const onCleared = () => clearWithheldWake(session);
    session.on('operator-input', onCleared);
    session.on('user-prompt', onCleared);
    session.on('exit', onCleared);
    session.on('teardown', onCleared);
    withheldWakeBySession.set(session, {
      line,
      pastedAt,
      onSettled,
      clear: () => {
        session.off('operator-input', onCleared);
        session.off('user-prompt', onCleared);
        session.off('exit', onCleared);
        session.off('teardown', onCleared);
      },
    });
  }

  function clearWakeLine(session: Session): void {
    wakeLineSubmittedAtBySession.delete(session);
    const boundTimer = turnStartBoundTimerBySession.get(session);
    if (boundTimer) clearTimeoutFn(boundTimer);
    turnStartBoundTimerBySession.delete(session);
    const turnStartListener = turnStartListenerBySession.get(session);
    if (!turnStartListener) return;
    session.off('state-change', turnStartListener);
    turnStartListenerBySession.delete(session);
  }

  function releaseWakeLine(session: Session): void {
    clearWakeLine(session);
    const waiters = wakeWaitersBySession.get(session);
    if (!waiters) return;
    wakeWaitersBySession.delete(session);
    for (const wakeWaiter of waiters.values()) wakeWaiter();
  }

  function waitForWakeLineRelease(recipient: Session, childId: string, side: ChannelSide): void {
    const waiters = wakeWaitersBySession.get(recipient) ?? new Map<string, () => void>();
    waiters.set(`${childId}:${side}`, () => wakeRecipient(childId, side));
    wakeWaitersBySession.set(recipient, waiters);
  }

  function holdWakeLineUntilTurnStart(session: Session): void {
    clearWakeLine(session);
    wakeLineSubmittedAtBySession.set(session, now());
    const turnStartListener = () => {
      if (session.isBetweenTurns()) return;
      releaseWakeLine(session);
    };
    turnStartListenerBySession.set(session, turnStartListener);
    session.on('state-change', turnStartListener);
    turnStartBoundTimerBySession.set(session, unrefTimer(setTimeoutFn(() => releaseWakeLine(session), WAKE_TURN_START_TIMEOUT_MS)));
  }

  function lastOperatorInputAtOf(session: Session): number {
    return lastOperatorInputAtBySession.get(session) ?? Number.NEGATIVE_INFINITY;
  }

  function msSinceOperatorInputOf(session: Session): number {
    return now() - lastOperatorInputAtOf(session);
  }

  function isWakeLineInFlight(session: Session): boolean {
    const submittedAt = wakeLineSubmittedAtBySession.get(session);
    if (submittedAt === undefined) return false;
    if (submittedAt === null) return true;
    if (isWakeLineAwaitingTurnStart(session.isBetweenTurns(), now() - submittedAt)) return true;
    releaseWakeLine(session);
    return wakeLineSubmittedAtBySession.has(session);
  }

  function submitWakeLine(recipient: Session, line: string, onSettled: (isSubmitted: boolean) => void, { when = 'idle' }: WakeLineDelivery = {}): boolean {
    if (isWakeLineInFlight(recipient)) return false;
    const withheld = withheldWakeBySession.get(recipient);
    if (withheld) {
      if (recipient._destroyed || !recipient.hasLivePty || (when === 'idle' && !recipient.isBetweenTurns())) return false;
      clearWithheldWake(recipient);
      if (shouldReuseWithheldWakeLine({ pastedAt: withheld.pastedAt, lastOperatorInputAt: lastOperatorInputAtOf(recipient) })) {
        recipient.write('\r');
        holdWakeLineUntilTurnStart(recipient);
        if (withheld.line !== line) {
          queueMicrotask(() => withheld.onSettled(true));
          return false;
        }
        queueMicrotask(() => onSettled(true));
        return true;
      }
    }
    const pastedAt = now();
    const delivered = recipient.deliver(line, {
      when,
      submit: true,
      onSettled: (settlement) => {
        const isSubmitted = settlement === 'submitted';
        if (!isSubmitted) {
          if (settlement === 'withheld' && shouldReuseWithheldWakeLine({ pastedAt, lastOperatorInputAt: lastOperatorInputAtOf(recipient) })) {
            rememberWithheldWake(recipient, line, pastedAt, onSettled);
          }
          releaseWakeLine(recipient);
          onSettled(false);
          return;
        }
        holdWakeLineUntilTurnStart(recipient);
        onSettled(true);
      },
    });
    if (!delivered.ok) return false;
    wakeLineSubmittedAtBySession.set(recipient, null);
    return true;
  }

  function typeWakeLine(childId: string, link: ChannelLink, channel: AgentChannel, side: ChannelSide, recipient: Session): void {
    const submittedSeq = highestWakingSeq(channel[side]);
    if (!submitWakeLine(recipient, describeWakeLine(channel, side), (isSubmitted) => {
      link.pendingWakeSides.delete(side);
      if (!isSubmitted) return;
      const current = channelsByChildId.get(childId);
      if (!current) return;
      channelsByChildId.set(childId, quietUnread(current, side, submittedSeq));
      syncUnreadFlag(recipientIdOf(current, side));
    })) {
      if (isWakeLineInFlight(recipient)) {
        waitForWakeLineRelease(recipient, childId, side);
        return;
      }
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
      waitForWakeLineRelease(recipient, childId, side);
      return;
    }
    const decision = decideWake({
      isRecipientBetweenTurns: recipient.isBetweenTurns(),
      hasUnread: hasWakingUnread(channel[side]),
      isWakePending: link.pendingWakeSides.has(side),
      msSinceOperatorInput: msSinceOperatorInputOf(recipient),
    });
    switch (decision.kind) {
      case 'none':
        return;
      case 'hold':
        scheduleWakeRetry(childId, link, side, decision.retryInMs);
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
      lastOperatorInputAtBySession.set(session, now());
    });
  }

  function withdrawWaitingStopNote(childId: string, link: ChannelLink): void {
    const channel = channelsByChildId.get(childId);
    if (!channel || link.waitingStopNoteText === null) return;
    channelsByChildId.set(childId, withdrawUnreadNote(channel, 'toParent', link.waitingStopNoteText));
    link.waitingStopNoteText = null;
    syncUnreadFlag(channel.parentId);
  }

  function withdrawStateOnlyStopNote(childId: string, link: ChannelLink): void {
    const channel = channelsByChildId.get(childId);
    if (!channel || link.stateOnlyStopNoteText === null) return;
    channelsByChildId.set(childId, withdrawUnreadNote(channel, 'toParent', link.stateOnlyStopNoteText));
    link.stateOnlyStopNoteText = null;
    syncUnreadFlag(channel.parentId);
  }

  function watchChild(link: ChannelLink, childId: string): () => void {
    let lastRelayedQuestionId: ConversationApproval['requestId'] | null = null;
    const relayQuestion = ({ conversationApproval }: { conversationApproval: ConversationApproval | null }) => {
      if (conversationApproval?.kind !== 'question' || conversationApproval.requestId === lastRelayedQuestionId) return;
      lastRelayedQuestionId = conversationApproval.requestId;
      withdrawWaitingStopNote(childId, link);
      const text = describeQuestionNote(link.child.name, childId, conversationApproval);
      post(childId, 'toParent', { author: 'glimmervoid', text, at: now(), wakes: true });
    };
    const keepLastMessage = ({ event, payload }: HookEvent) => {
      if (event.toLowerCase() !== 'stop') return;
      link.lastChildMessage = readLastAssistantMessage(payload);
    };
    const wakeBothSides = () => {
      wakeRecipient(childId, 'toParent');
      wakeRecipient(childId, 'toChild');
    };
    const relayStateChange = ({ from, to, event }: StateChange) => {
      const isHeldQuestionWaiting = to === STATES.WAITING && link.child._conversationApproval?.kind === 'question';
      if (!isHeldQuestionWaiting && shouldPostStopNote(from, to, event)) {
        const text = describeStopNote({ childName: link.child.name, state: to, lastMessage: link.lastChildMessage });
        withdrawStateOnlyStopNote(childId, link);
        post(childId, 'toParent', { author: 'glimmervoid', text, at: now(), wakes: endCauseByChildId.get(childId) !== 'parent-closed' && shouldStopNoteWake(to, link.hasParentRead) });
        link.stateOnlyStopNoteText = link.lastChildMessage === null ? text : null;
        link.lastChildMessage = null;
        link.waitingStopNoteText = to === STATES.WAITING ? text : null;
      }
      wakeBothSides();
    };
    link.child.on('conversation-change', relayQuestion);
    link.child.on('hook-event', keepLastMessage);
    link.child.on('state-change', relayStateChange);
    link.child.on('turn-end-held', wakeBothSides);
    return () => {
      link.child.off('conversation-change', relayQuestion);
      link.child.off('hook-event', keepLastMessage);
      link.child.off('state-change', relayStateChange);
      link.child.off('turn-end-held', wakeBothSides);
    };
  }

  function openChildChannel(parent: Session, child: Session, childName: string, kind: ChannelKind = 'spawned'): () => void {
    const keptChannel = channelsByChildId.get(child.id);
    channelsByChildId.set(child.id, kind === 'branch' && keptChannel?.kind === 'branch' && keptChannel.parentId === parent.id ? keptChannel : openChannel({ kind, parentId: parent.id, childId: child.id, childName }));
    const link: ChannelLink = {
      parent, child, lastChildMessage: null, waitingStopNoteText: null, stateOnlyStopNoteText: null, hasParentRead: false, pendingWakeSides: new Set(), retryTimersBySide: new Map(), stopWatchingChild: () => {},
    };
    linksByChildId.get(child.id)?.stopWatchingChild();
    linksByChildId.set(child.id, link);
    const stopWatching = watchChild(link, child.id);
    const unlinkFromParent = parent.noteChildLinked(child);
    link.stopWatchingChild = () => {
      stopWatching();
      unlinkFromParent();
    };
    watchOperatorInput(parent);
    watchOperatorInput(child);
    if (!parentsWithChannelCleanup.has(parent)) {
      parentsWithChannelCleanup.add(parent);
      parent.once('teardown', () => forgetChannelsOf(parent));
    }
    const wakeParent = () => wakeRecipient(child.id, 'toParent');
    parent.on('state-change', wakeParent);
    parent.on('turn-end-held', wakeParent);
    const stopWakingParent = () => {
      parent.off('state-change', wakeParent);
      parent.off('turn-end-held', wakeParent);
    };
    if (kind === 'branch') return stopWakingParent;
    const closeChildWithParent = () => {
      noteEndCause(child.id, 'parent-ended');
      child.destroy();
    };
    parent.on('exit', closeChildWithParent);
    parent.on('teardown', closeChildWithParent);
    return () => {
      parent.off('exit', closeChildWithParent);
      parent.off('teardown', closeChildWithParent);
    };
  }

  function liveSessionOf(sessionId: string): Session | null {
    return listAllSessions().find((session) => session.id === sessionId && !session._destroyed) ?? null;
  }

  function openBranchChannel(main: Session, branch: Session): void {
    if (linksByChildId.get(branch.id)?.parent === main || main._destroyed || branch._destroyed) return;
    const detachFromMain = openChildChannel(main, branch, branch.name, 'branch');
    const forgetBranch = () => {
      detachFromMain();
      const link = linksByChildId.get(branch.id);
      if (!link || link.parent === main) forgetLink(branch.id);
    };
    branch.once('teardown', forgetBranch);
    wakeRecipient(branch.id, 'toParent');
    wakeRecipient(branch.id, 'toChild');
  }

  function linkBranchSession(session: Session): void {
    const mainId = branchParentIdOf(session.parent);
    if (mainId !== null) {
      const main = liveSessionOf(mainId);
      if (main) openBranchChannel(main, session);
      return;
    }
    if (!session.isStudioMain) return;
    for (const candidate of listAllSessions()) {
      if (branchParentIdOf(candidate.parent) === session.id && !candidate._destroyed) openBranchChannel(session, candidate);
    }
  }

  function tellParent(childId: string, text: string): boolean {
    if (!channelsByChildId.has(childId)) return false;
    post(childId, 'toParent', { author: 'glimmervoid', text, at: now(), wakes: true });
    return true;
  }

  async function keepOrDiscardChildWorktree(child: Session, worktree: ChildWorktree | null, isParentRemoved: boolean): Promise<boolean> {
    const isDiscardRequested = childIdsToDiscard.delete(child.id);
    if (isDiscardRequested || isParentRemoved) child.confirmWorkspaceWorkDiscard();
    await child.releaseCheckouts();
    if (!worktree) return false;
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
    syncUnreadFlag(recipientIdOf(channel, side));
    wakeRecipient(childId, side);
  }

  function drain(childId: string, side: ChannelSide): AgentReadReply['channels'][number] | null {
    const channel = channelsByChildId.get(childId);
    if (!channel) return null;
    const { channel: drainedChannel, drained } = drainChannelPage(channel, side);
    channelsByChildId.set(childId, drainedChannel);
    syncUnreadFlag(recipientIdOf(drainedChannel, side));
    const link = linksByChildId.get(childId);
    if (link && side === 'toParent' && drained.entries.length > 0) link.hasParentRead = true;
    const peerId = side === 'toParent' ? channel.childId : channel.parentId;
    const peerName = side === 'toParent' ? channel.childName : (listAllSessions().find((session) => session.id === channel.parentId)?.name ?? channel.parentId);
    return {
      sessionId: peerId,
      name: peerName,
      entries: drained.entries.map(({ author, at, text, truncated, offset, totalChars, remainingChars }) => ({
        from: author,
        at,
        text,
        ...(truncated === undefined ? {} : { truncated }),
        ...(offset === undefined ? {} : { offset }),
        ...(totalChars === undefined ? {} : { totalChars }),
        ...(remainingChars === undefined ? {} : { remainingChars }),
      })),
      dropped: drained.droppedCount,
      nextCursor: drained.nextCursor,
    };
  }

  function drainAtCursor(childId: string, side: ChannelSide, cursor: ChannelPageCursor): AgentReadReply['channels'][number] | null {
    const channel = channelsByChildId.get(childId);
    if (!channel || !matchesMailboxCursor(channel[side], cursor)) return null;
    return drain(childId, side);
  }

  function ownedChannels(parent: Session): AgentChannel[] {
    return [...channelsByChildId.values()].filter((channel) => channel.parentId === parent.id);
  }

  function findChildOf(parent: Session, target: string) {
    return findOwnedChild(ownedChannels(parent), parent.id, target);
  }

  function findSiblingOf(child: Session, target: string) {
    return findSibling([...channelsByChildId.values()], child.id, target);
  }

  function takeInTurnNotice(sessionId: string): string | null {
    const { updatedChannels, notices } = takeSessionInTurnNotices([...channelsByChildId.values()], sessionId);
    for (const channel of updatedChannels) channelsByChildId.set(channel.childId, channel);
    syncUnreadFlag(sessionId);
    return notices.length === 0 ? null : notices.join('\n');
  }

  return { noteEndCause, forgetLink, openChildChannel, linkBranchSession, liveSessionOf, tellParent, settleChildWorktree, post, drain, drainAtCursor, ownedChannels, findChildOf, findSiblingOf, watchOperatorInput, msSinceOperatorInputOf, isWakeLineInFlight, submitWakeLine, takeInTurnNotice };
}

type ChildChannels = ReturnType<typeof createChildChannels>;

export { createChildChannels };
export type { ChildChannels };
