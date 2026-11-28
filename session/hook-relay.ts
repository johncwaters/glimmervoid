import { readStdin } from "./relay-stdin.ts";
import type { StdinLike } from "./relay-stdin.ts";

import { hasTopLevelAgentId } from "../shared/hook-oversize-core.ts";
import { decideRelayPost } from "./core/hook-relay-core.ts";
import { postToLoopback } from "./loopback-post.ts";

function strippedOversizeBodyOf(body: Buffer): Buffer {
  return Buffer.from(hasTopLevelAgentId(body) ? '{"agent_id":"subagent"}' : "{}", "utf8");
}

async function main(
  argv: string[] = process.argv.slice(2),
  stdin: StdinLike = process.stdin,
  env: Record<string, string | undefined> = process.env,
  stdout: { write(text: string): unknown } = process.stdout,
): Promise<{ code: number; reason: string }> {
  const [event, deliveryMode] = argv;
  const body = await readStdin(stdin);
  const verdict = decideRelayPost({ env, event, payloadBytes: body.length, isAsync: deliveryMode === "async" });
  if (!verdict.post || !verdict.url || !verdict.event) return { code: 0, reason: verdict.reason };
  const postedBody = verdict.shouldStripOversizeBody ? strippedOversizeBodyOf(body) : body;
  const response = await postToLoopback(verdict.url, postedBody, verdict.postTimeoutMs);
  if (!response.responseBody) return { code: 0, reason: response.reason };
  const { relayedHookContextOutput } = await import("./core/refocus-core.ts");
  const contextOutput = relayedHookContextOutput(verdict.event, response.responseBody);
  if (contextOutput !== null) stdout.write(contextOutput);
  return { code: 0, reason: response.reason };
}

if (process.argv[1] === import.meta.filename) {
  main().then((result) => process.exit(result.code)).catch(() => process.exit(0));
}

export { main };
