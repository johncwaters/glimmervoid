import http from "node:http";

import { readStdin } from "./relay-stdin.ts";
import type { StdinLike } from "./relay-stdin.ts";

import {
  MAX_RESPONSE_BYTES,
  decideRelayPost,
} from "./core/hook-relay-core.ts";

const POST_TIMEOUT_MS = 1500;

interface PostResponse {
  reason: string;
}

function postPayload(url: string, body: Buffer): Promise<PostResponse> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (response: PostResponse): void => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      done({ reason: "bad-url" });
      return;
    }
    try {
      const req = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": body.length,
          },
        },
        (res) => {
          let responseBytes = 0;
          res.on("data", (chunk: Buffer) => {
            if (settled) return;
            responseBytes += chunk.length;
            if (responseBytes > MAX_RESPONSE_BYTES) {
              res.destroy();
              done({ reason: "response-too-large" });
              return;
            }
          });
          res.on("end", () => done({ reason: `status-${res.statusCode}` }));
          res.on("error", () => done({ reason: "response-error" }));
        },
      );
      req.on("error", () => done({ reason: "request-error" }));
      req.setTimeout(POST_TIMEOUT_MS, () => {
        req.destroy();
        done({ reason: "timeout" });
      });
      req.end(body);
    } catch {
      done({ reason: "request-throw" });
    }
  });
}

async function main(
  argv: string[] = process.argv.slice(2),
  stdin: StdinLike = process.stdin,
  env: Record<string, string | undefined> = process.env,
): Promise<{ code: number; reason: string }> {
  const [event] = argv;
  const body = await readStdin(stdin);
  const verdict = decideRelayPost({ env, event, payloadBytes: body.length });
  if (!verdict.post || !verdict.url) return { code: 0, reason: verdict.reason };
  const response = await postPayload(verdict.url, body);
  return { code: 0, reason: response.reason };
}

if (process.argv[1] === import.meta.filename) {
  main().then((result) => process.exit(result.code)).catch(() => process.exit(0));
}

export { main, postPayload, POST_TIMEOUT_MS };
