import { createCoalescedTimer } from '../shared/coalesce-timer.ts';

const DEFAULT_DIGEST_WINDOW_MS = 1000;

const TELEGRAM_MESSAGE_MAX_CHARS = 4096;

const DIGEST_SEPARATOR = '\n';

function packIntoMessages(texts: string[]): string[] {
  const messages: string[] = [];
  for (const text of texts) {
    const lastIndex = messages.length - 1;
    const lastMessage = messages[lastIndex];
    const canAppend = lastMessage !== undefined
      && lastMessage.length + DIGEST_SEPARATOR.length + text.length <= TELEGRAM_MESSAGE_MAX_CHARS;
    if (!canAppend) {
      messages.push(text);
      continue;
    }
    messages[lastIndex] = `${lastMessage}${DIGEST_SEPARATOR}${text}`;
  }
  return messages;
}

function createTelegramDigest({
  deliver,
  windowMs = DEFAULT_DIGEST_WINDOW_MS,
}: {
  deliver: (text: string) => Promise<void>;
  windowMs?: number;
}) {
  let bufferedTexts: string[] = [];
  const flushTimer = createCoalescedTimer({ mode: 'leading', delayMs: windowMs, run: () => { void flush(); } });

  function flush(): Promise<void> {
    flushTimer.cancel();
    if (bufferedTexts.length === 0) return Promise.resolve();
    const digestMessages = packIntoMessages(bufferedTexts);
    bufferedTexts = [];
    return Promise.all(digestMessages.map((message) => deliver(message))).then(() => undefined);
  }

  function bufferText(text: string): Promise<void> {
    bufferedTexts.push(text);
    flushTimer.schedule();
    return Promise.resolve();
  }

  return { deliver: bufferText, flush };
}

export { createTelegramDigest };
