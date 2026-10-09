import { isLoopbackHostname } from "../shared/loopback-hosts.ts";
import http from 'node:http';
import { MAX_RESPONSE_BYTES } from './core/hook-relay-core.ts';

const POST_TIMEOUT_MS = 1500;

interface LoopbackPostOutcome {
  reason: string;
  responseBody: string | null;
}

function postToLoopback(url: string, body: Buffer): Promise<LoopbackPostOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (reason: string, responseBody: string | null = null): void => {
      if (settled) return;
      settled = true;
      resolve({ reason, responseBody });
    };
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      done('bad-url');
      return;
    }
    if (target.protocol !== 'http:') {
      done('not-http');
      return;
    }
    if (!isLoopbackHostname(target.hostname)) {
      done('not-loopback');
      return;
    }
    try {
      const request = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let responseBytes = 0;
          response.on('data', (chunk: Buffer) => {
            if (settled) return;
            responseBytes += chunk.length;
            if (responseBytes > MAX_RESPONSE_BYTES) {
              response.destroy();
              done('response-too-large');
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => done(`status-${response.statusCode}`, Buffer.concat(chunks).toString('utf8')));
          response.on('error', () => done('response-error'));
          response.on('close', () => done('response-error'));
        },
      );
      request.on('error', () => done('request-error'));
      request.setTimeout(POST_TIMEOUT_MS, () => {
        request.destroy();
        done('timeout');
      });
      request.end(body);
    } catch {
      done('request-throw');
    }
  });
}

async function postPayload(url: string, body: Buffer): Promise<string | null> {
  const outcome = await postToLoopback(url, body);
  return outcome.responseBody;
}

export { postPayload, postToLoopback, POST_TIMEOUT_MS };
export type { LoopbackPostOutcome };
