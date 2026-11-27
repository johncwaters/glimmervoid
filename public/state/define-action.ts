import { action, flush } from 'solid-js';
import { clock } from '#shared/clock.ts';
import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import type { CLIENT_MESSAGE_CLASS } from '#shared/contracts/control/message-classes.ts';
import { DEFAULT_REPLY_TIMEOUT_MS, reportHeaderError, requestFailureText } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { REQUEST_TIMED_OUT_TEXT } from '../updates-view-core.ts';
import { addCollectionOptimisticOverlay } from './define-collection.ts';
import type { CollectionHandle, OptimisticDraftUpdater } from './define-collection.ts';
import { whenSeqReached } from './seq.ts';

export type MutatingClientMessageType = {
  [Type in keyof typeof CLIENT_MESSAGE_CLASS]: (typeof CLIENT_MESSAGE_CLASS)[Type] extends 'mutating' ? Type : never;
}[keyof typeof CLIENT_MESSAGE_CLASS];

export type OptimisticApplier = <State extends object>(
  collection: CollectionHandle<State>,
  updater: OptimisticDraftUpdater<State>,
) => void;

export type ControlRequester = (
  type: string,
  payload?: Record<string, unknown>,
  options?: { timeoutMs?: number },
) => Promise<ServerMessage>;

export interface ActionOptions<Input = Record<string, unknown>> {
  type: MutatingClientMessageType;
  payload?: (input: Input) => Record<string, unknown>;
  optimistic?: (input: Input, apply: OptimisticApplier) => void;
  rollbackNotice: string | ((error: unknown, input: Input) => string);
  noticeSource?: string;
  timeoutMs?: number | ((input: Input) => number);
  isReplyOk?: (reply: ServerMessage) => boolean;
  request?: ControlRequester;
}

export type ActionResult =
  | { ok: true; reply: ServerMessage }
  | { ok: false; error: Error };

function defaultIsReplyOk(reply: ServerMessage): boolean {
  if (reply.type === 'error' || reply.type === 'settings-error') return false;
  if ('ok' in reply && reply.ok === false) return false;
  return true;
}

function replyErrorMessage(reply: ServerMessage): string {
  if ('error' in reply && typeof reply.error === 'string' && reply.error.length > 0) return reply.error;
  if ('message' in reply && typeof reply.message === 'string' && reply.message.length > 0) return reply.message;
  return `Request failed with ${reply.type}.`;
}

function payloadForInput<Input>(input: Input, buildPayload?: (value: Input) => Record<string, unknown>): Record<string, unknown> {
  if (buildPayload) return buildPayload(input);
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

async function awaitAppliedSeqWithBudget(appliedSeq: number, startedAtMs: number, timeoutMs: number): Promise<void> {
  const remainingMs = Math.max(1, timeoutMs - (clock.nowMs() - startedAtMs));
  const abortController = new AbortController();
  const timer = setTimeout(() => {
    abortController.abort(new Error(REQUEST_TIMED_OUT_TEXT));
  }, remainingMs);
  try {
    await whenSeqReached(appliedSeq, { signal: abortController.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function defineAction<Input = Record<string, unknown>>(
  options: ActionOptions<Input>,
): (input: Input) => Promise<ActionResult> {
  const resolveTimeoutMs = (input: Input): number => (
    typeof options.timeoutMs === 'function'
      ? options.timeoutMs(input)
      : (options.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS)
  );
  const checkReplyOk = options.isReplyOk ?? defaultIsReplyOk;

  const runTransaction = action(async function* (input: Input): AsyncGenerator<unknown, ServerMessage, unknown> {
    const startedAtMs = clock.nowMs();
    const timeoutMs = resolveTimeoutMs(input);
    const requestPayload = payloadForInput(input, options.payload);
    const sendRequest = options.request ?? sendControlRequest;
    const reply = await sendRequest(options.type, requestPayload, { timeoutMs });
    if (!checkReplyOk(reply)) {
      throw new Error(replyErrorMessage(reply));
    }
    const appliedSeq = 'appliedSeq' in reply && typeof reply.appliedSeq === 'number' ? reply.appliedSeq : null;
    if (appliedSeq !== null) {
      await awaitAppliedSeqWithBudget(appliedSeq, startedAtMs, timeoutMs);
    }
    yield;
    return reply;
  });

  return async function runDefinedAction(input: Input): Promise<ActionResult> {
    const timeoutMs = resolveTimeoutMs(input);
    const releaseOverlays: Array<() => void> = [];
    const applyOptimistic: OptimisticApplier = (collection, updater) => {
      releaseOverlays.push(addCollectionOptimisticOverlay(collection, updater));
    };

    try {
      options.optimistic?.(input, applyOptimistic);
      if (releaseOverlays.length > 0) flush();
      const reply = await runTransaction(input);
      return { ok: true, reply };
    } catch (reason) {
      const error = new Error(requestFailureText(reason, timeoutMs));
      const noticeMessage = typeof options.rollbackNotice === 'function'
        ? options.rollbackNotice(error, input)
        : options.rollbackNotice;
      reportHeaderError({
        source: options.noticeSource ?? 'Action',
        message: noticeMessage,
      });
      return { ok: false, error };
    } finally {
      for (let index = releaseOverlays.length - 1; index >= 0; index -= 1) {
        releaseOverlays[index]();
      }
      if (releaseOverlays.length > 0) flush();
    }
  };
}
