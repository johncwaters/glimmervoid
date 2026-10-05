import { readStdin } from "./relay-stdin.ts";
import type { StdinLike } from "./relay-stdin.ts";

import { decideRelayPost } from "./core/hook-relay-core.ts";
import { postToLoopback } from "./loopback-post.ts";

async function main(
  argv: string[] = process.argv.slice(2),
  stdin: StdinLike = process.stdin,
  env: Record<string, string | undefined> = process.env,
): Promise<{ code: number; reason: string }> {
  const [event] = argv;
  const body = await readStdin(stdin);
  const verdict = decideRelayPost({ env, event, payloadBytes: body.length });
  if (!verdict.post || !verdict.url) return { code: 0, reason: verdict.reason };
  const response = await postToLoopback(verdict.url, body);
  return { code: 0, reason: response.reason };
}

if (process.argv[1] === import.meta.filename) {
  main().then((result) => process.exit(result.code)).catch(() => process.exit(0));
}

export { main };
