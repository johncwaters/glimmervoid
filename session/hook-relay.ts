import type { StdinLike } from "./relay-stdin.ts";

const fs = process.getBuiltinModule("node:fs");
const UNREAD_FLAG_ENV = "GV_UNREAD_FLAG";

async function main(
  argv: string[] = process.argv.slice(2),
  stdin: StdinLike = process.stdin,
  env: Record<string, string | undefined> = process.env,
  stdout: { write(text: string): unknown } = process.stdout,
): Promise<{ code: number; reason: string }> {
  const [event, deliveryMode] = argv;
  if (deliveryMode === "unread") {
    const flagPath = env[UNREAD_FLAG_ENV];
    if (!flagPath || !fs.existsSync(flagPath)) return { code: 0, reason: "no-unread" };
  }
  const [{ readStdin }, { decideRelayPost }, { postToLoopback }] = await Promise.all([
    import("./relay-stdin.ts"),
    import("./core/hook-relay-core.ts"),
    import("./loopback-post.ts"),
  ]);
  const body = await readStdin(stdin);
  const verdict = decideRelayPost({ env, event, payloadBytes: body.length, isAsync: deliveryMode === "async" });
  if (!verdict.post || !verdict.url || !verdict.event) return { code: 0, reason: verdict.reason };
  let postedBody = body;
  if (verdict.shouldStripOversizeBody) {
    const { hasTopLevelAgentId } = await import("../shared/hook-oversize-core.ts");
    postedBody = Buffer.from(hasTopLevelAgentId(body) ? '{"agent_id":"subagent"}' : "{}", "utf8");
  }
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
