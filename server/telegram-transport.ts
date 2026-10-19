import https from 'node:https';

interface TelegramBody {
  chat_id: string;
  text: string;
}

type TelegramTransport = (url: string, body: TelegramBody, options?: TelegramSendBounds) => Promise<unknown>;

interface TelegramSendBounds {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10000;

interface SendTelegramOptions {
  botToken: string;
  chatId: string;

  text: string;

  tag?: string;

  transport?: TelegramTransport | null;

  timeoutMs?: number;
}

interface SendTelegramResult {
  ok: boolean;
  error: string | null;
}

function telegramRefusalText(statusCode: number, responseText: string): string {
  const description = telegramErrorDescription(responseText);
  return description ? `Telegram answered ${statusCode}: ${description}` : `Telegram answered ${statusCode}`;
}

function telegramErrorDescription(responseText: string): string {
  try {
    const parsed: unknown = JSON.parse(responseText);
    if (typeof parsed !== 'object' || parsed === null || !('description' in parsed)) return '';
    return typeof parsed.description === 'string' ? parsed.description.slice(0, 200) : '';
  } catch {
    return '';
  }
}

function noAnswerText(timeoutMs: number): string {
  const waited = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`;
  return `Telegram did not answer within ${waited}`;
}

function defaultTransport(url: string, bodyObject: TelegramBody, options?: TelegramSendBounds): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObject);
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const responseChunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { responseChunks.push(chunk); });
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0;
          if (statusCode >= 200 && statusCode < 300) {
            resolve();
            return;
          }
          reject(new Error(telegramRefusalText(statusCode, Buffer.concat(responseChunks).toString('utf8'))));
        });
      },
    );
    req.on('error', reject);
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => { req.destroy(new Error(noAnswerText(timeoutMs))); });
    req.write(body);
    req.end();
  });
}

async function withinTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work;
  void work.catch(() => {});
  let expiryTimer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, rejectOnExpiry) => {
    expiryTimer = setTimeout(() => rejectOnExpiry(new Error(noAnswerText(timeoutMs))), timeoutMs);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (expiryTimer) clearTimeout(expiryTimer);
  }
}

async function sendTelegramMessage({
  botToken, chatId, text, tag = 'telegram', transport, timeoutMs = DEFAULT_TIMEOUT_MS,
}: SendTelegramOptions): Promise<SendTelegramResult> {
  const send = transport || defaultTransport;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    await withinTimeout(send(url, { chat_id: chatId, text }, { timeoutMs }), timeoutMs);
    return { ok: true, error: null };
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : String(err);
    console.warn(`[${tag}] ${message}`);
    return { ok: false, error: message };
  }
}

export { sendTelegramMessage };
