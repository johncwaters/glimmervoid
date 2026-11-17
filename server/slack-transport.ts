import https from 'node:https';
import { SLACK_WEBHOOK_URL_PREFIX } from '../shared/contracts/browser-config.ts';
import { errorMessage } from '../shared/text.ts';

const SLACK_TIMEOUT_MS = 10_000;

interface SendSlackOptions {
  webhookUrl: string;
  text: string;
}

function slackEscaped(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function postWebhook(webhookUrl: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text: slackEscaped(text) });
    const request = https.request(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (response) => {
      response.resume();
      response.on('end', () => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode >= 200 && statusCode < 300) {
          resolve();
          return;
        }
        reject(new Error(`Slack answered ${statusCode}`));
      });
    });
    request.on('error', reject);
    request.setTimeout(SLACK_TIMEOUT_MS, () => { request.destroy(new Error(`Slack did not answer within ${SLACK_TIMEOUT_MS / 1000} s`)); });
    request.write(body);
    request.end();
  });
}

async function sendSlackMessage({ webhookUrl, text }: SendSlackOptions): Promise<{ ok: boolean; error: string | null }> {
  if (!webhookUrl.startsWith(SLACK_WEBHOOK_URL_PREFIX)) return { ok: false, error: `the webhook URL must start with ${SLACK_WEBHOOK_URL_PREFIX}` };
  try {
    await postWebhook(webhookUrl, text);
    return { ok: true, error: null };
  } catch (error) {
    console.warn(`[channel:slack] ${errorMessage(error)}`);
    return { ok: false, error: errorMessage(error) };
  }
}

export { sendSlackMessage };
