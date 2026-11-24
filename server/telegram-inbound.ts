import https from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseInboundUpdate, routeInbound, sessionTagFor, withoutSessionTags } from './core/telegram-inbound-core.ts';
import type { InboundRoute, RoutableSession } from './core/telegram-inbound-core.ts';
import { errorMessage } from '../shared/text.ts';
import type { Session } from '../session/sessions.ts';

const LONG_POLL_SECONDS = 25;
const REQUEST_TIMEOUT_MS = (LONG_POLL_SECONDS + 10) * 1000;
const ERROR_BACKOFF_MS = 10_000;
const LASTING_REFUSAL_STATUS_CODES = new Set([401, 404, 409]);

class TelegramPollRefusal extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super(statusCode === 409 ? 'Telegram refused getUpdates with 409: another process polls this bot or a webhook is set, so Telegram replies are off' : `Telegram refused getUpdates with ${statusCode}, so Telegram replies are off until the bot token changes`);
    this.statusCode = statusCode;
  }
}

interface TelegramInboundConfig {
  botToken: string;
  chatId: string;
  isAcceptingReplies: boolean;
}

type FetchUpdates = (botToken: string, query: { offset: number; timeoutSeconds: number }, abandoned: AbortSignal) => Promise<unknown[]>;

interface TelegramInboundDeps {
  readConfig: () => TelegramInboundConfig;
  liveSessions: () => Iterable<Session>;
  replyInChat: (text: string) => unknown;
  onLastingRefusal: (message: string) => void;
  logger: Pick<Console, 'warn'>;
  fetchUpdates?: FetchUpdates;
}

function updatesOf(responseText: string): unknown[] {
  const parsed: unknown = JSON.parse(responseText);
  if (typeof parsed !== 'object' || parsed === null || !('ok' in parsed) || parsed.ok !== true || !('result' in parsed) || !Array.isArray(parsed.result)) {
    throw new Error('Telegram getUpdates answered without a result list');
  }
  return parsed.result;
}

function fetchTelegramUpdates(botToken: string, { offset, timeoutSeconds }: { offset: number; timeoutSeconds: number }, abandoned: AbortSignal): Promise<unknown[]> {
  const url = `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=${timeoutSeconds}&allowed_updates=${encodeURIComponent('["message"]')}`;
  return new Promise((resolve, reject) => {
    const request = https.get(url, { signal: abandoned }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      response.on('end', () => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          reject(new TelegramPollRefusal(statusCode));
          return;
        }
        try {
          resolve(updatesOf(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.setTimeout(REQUEST_TIMEOUT_MS, () => { request.destroy(new Error('Telegram getUpdates timed out')); });
  });
}

function routableSessionOf(session: Session): RoutableSession {
  const approval = session._conversationApproval;
  if (approval === null) return { id: session.id, name: session.name, heldQuestion: null };
  const questions = approval.questions ?? [];
  const [onlyQuestion] = questions;
  const isAnswerableFromChat = questions.length === 1 && !onlyQuestion.multiSelect && !approval.isSummaryTruncated;
  return {
    id: session.id,
    name: session.name,
    heldQuestion: isAnswerableFromChat
      ? { question: onlyQuestion.question, optionLabels: onlyQuestion.options.map((option) => option.label) }
      : { question: approval.summary.slice(0, 300), optionLabels: [] },
  };
}

function createTelegramInbound({ readConfig, liveSessions, replyInChat, onLastingRefusal, logger, fetchUpdates = fetchTelegramUpdates }: TelegramInboundDeps) {
  const stopping = new AbortController();
  let nextOffset: number | null = null;
  let pollingToken = '';
  let refusedToken: string | null = null;
  let wakeIdleLoop: (() => void) | null = null;
  stopping.signal.addEventListener('abort', () => noteConfigChanged(), { once: true });

  function noteConfigChanged(): void {
    const wake = wakeIdleLoop;
    wakeIdleLoop = null;
    wake?.();
  }

  function untilConfigChanges(): Promise<void> {
    return new Promise((resolve) => { wakeIdleLoop = resolve; });
  }

  function pause(delayMs: number): Promise<void> {
    return sleep(delayMs, undefined, { signal: stopping.signal, ref: false }).catch(() => {});
  }

  function act(route: InboundRoute): void {
    if (route.kind === 'reply') {
      replyInChat(route.text);
      return;
    }
    const session = [...liveSessions()].find((candidate) => candidate.id === route.sessionId);
    if (!session) {
      replyInChat('That session has ended.');
      return;
    }
    const name = withoutSessionTags(session.name);
    const tag = sessionTagFor(session.id);
    if (route.kind === 'answer') {
      const approval = session._conversationApproval;
      const isAnswered = approval !== null && session.answerConversationApproval(approval.requestId, { [route.question]: route.option });
      replyInChat(isAnswered ? `Answered ${name}: ${withoutSessionTags(route.option)} ${tag}` : `${name} is no longer waiting on that question. ${tag}`);
      return;
    }
    session.noteOperatorDraft();
    const delivery = session.deliver(route.text, { when: 'ready', submit: true });
    replyInChat(delivery.ok ? `Sent to ${name}. ${tag}` : `${name} did not take the text (${delivery.reason}). ${tag}`);
  }

  function handle(updates: readonly unknown[], chatId: string): void {
    for (const update of updates) {
      const parsed = parseInboundUpdate(update, chatId);
      if (parsed === null) continue;
      nextOffset = Math.max(nextOffset ?? 0, parsed.updateId + 1);
      if (parsed.message === null) continue;
      act(routeInbound(parsed.message, [...liveSessions()].map(routableSessionOf)));
    }
  }

  async function skipBacklog(botToken: string): Promise<void> {
    const backlog = await fetchUpdates(botToken, { offset: -1, timeoutSeconds: 0 }, stopping.signal);
    const lastUpdateIds = backlog.flatMap((update) => parseInboundUpdate(update, '')?.updateId ?? []);
    nextOffset = lastUpdateIds.length > 0 ? Math.max(...lastUpdateIds) + 1 : 0;
  }

  async function pollOnce(): Promise<void> {
    const { botToken, chatId, isAcceptingReplies } = readConfig();
    if (botToken !== refusedToken) refusedToken = null;
    if (!isAcceptingReplies || botToken.length === 0 || chatId.length === 0 || botToken === refusedToken) {
      nextOffset = null;
      await untilConfigChanges();
      return;
    }
    if (botToken !== pollingToken) {
      pollingToken = botToken;
      nextOffset = null;
    }
    if (nextOffset === null) {
      await skipBacklog(botToken);
      return;
    }
    const updates = await fetchUpdates(botToken, { offset: nextOffset, timeoutSeconds: LONG_POLL_SECONDS }, stopping.signal);
    if (stopping.signal.aborted) return;
    const current = readConfig();
    if (!current.isAcceptingReplies || current.botToken !== botToken) return;
    handle(updates, current.chatId);
  }

  async function run(): Promise<void> {
    while (!stopping.signal.aborted) {
      try {
        await pollOnce();
      } catch (error) {
        if (stopping.signal.aborted) return;
        logger.warn(`[telegram-inbound] ${errorMessage(error)}`);
        if (error instanceof TelegramPollRefusal && LASTING_REFUSAL_STATUS_CODES.has(error.statusCode)) {
          refusedToken = pollingToken;
          onLastingRefusal(error.message);
          continue;
        }
        await pause(ERROR_BACKOFF_MS);
      }
    }
  }

  return {
    start: () => { void run(); },
    stop: () => { stopping.abort(); },
    noteConfigChanged,
  };
}

export { createTelegramInbound };
