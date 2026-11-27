import fs from "node:fs";
import readline from "node:readline";

type WireMessage = { id?: number | string; method?: string } & Record<string, unknown>;
type RecordedLine = { direction: "client->agent" | "agent->client" | "note"; message: unknown };

const [recordingPath, launchNumberText, email, plan, receivedLogPath] = process.argv.slice(2);
const launchNumber = Number(launchNumberText);

function recordedLinesOfLaunch(): RecordedLine[] {
  const text = fs.readFileSync(recordingPath, "utf8").split("<redacted:email>").join(email).split("<redacted:account>").join(plan);
  const lines = text.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as RecordedLine);
  const launchIndexes = lines.flatMap((line, index) => (line.direction === "note" && String(line.message).startsWith("launch ") ? [index] : []));
  return lines.slice(launchIndexes[launchNumber - 1], launchIndexes[launchNumber] ?? lines.length);
}

const incoming: WireMessage[] = [];
let wakeReader: (() => void) | null = null;
let isInputClosed = false;
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (line.trim().length === 0) return;
  if (receivedLogPath !== undefined) fs.appendFileSync(receivedLogPath, `${line.trim()}\n`);
  incoming.push(JSON.parse(line) as WireMessage);
  wakeReader?.();
});
input.on("close", () => {
  isInputClosed = true;
  wakeReader?.();
});

async function peekClientMessage(): Promise<WireMessage | null> {
  while (incoming.length === 0 && !isInputClosed) await new Promise<void>((resolve) => { wakeReader = resolve; });
  return incoming[0] ?? null;
}

function send(message: WireMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function unrecordedReplyFor(method: string | undefined): Record<string, unknown> | null {
  if (method === "session/set_mode") return {};
  if (method === "_codex/hooks/list") return { cwd: "", hooks: [] };
  if (method === "_codex/hooks/trust") return { trusted: false };
  return null;
}

async function replay(): Promise<void> {
  const liveIdByRecordedId = new Map<number | string, number | string>();
  const skippedRecordedIds = new Set<number | string>();
  for (const line of recordedLinesOfLaunch()) {
    if (line.direction === "note") continue;
    const recorded = line.message as WireMessage;
    const isResponse = recorded.method === undefined && recorded.id !== undefined;
    if (line.direction === "agent->client" && isResponse && skippedRecordedIds.has(recorded.id as number)) continue;
    if (line.direction === "agent->client" && isResponse) {
      send({ ...recorded, id: liveIdByRecordedId.get(recorded.id as number) });
      continue;
    }
    if (line.direction === "agent->client") {
      send(recorded);
      continue;
    }
    let live = await peekClientMessage();
    while (live !== null && live.method !== recorded.method) {
      const unrecordedReply = unrecordedReplyFor(live.method);
      if (unrecordedReply === null) break;
      incoming.shift();
      if (live.id !== undefined) send({ jsonrpc: "2.0", id: live.id, result: unrecordedReply });
      live = await peekClientMessage();
    }
    if (live === null) return;
    const isSameMessage = recorded.method === undefined ? live.method === undefined && live.id === recorded.id : live.method === recorded.method;
    if (!isSameMessage && recorded.id !== undefined) skippedRecordedIds.add(recorded.id);
    if (!isSameMessage) continue;
    incoming.shift();
    if (recorded.method !== undefined && recorded.id !== undefined && live.id !== undefined) liveIdByRecordedId.set(recorded.id, live.id);
  }
}

await replay();
while (!isInputClosed) await peekClientMessage().then(() => incoming.shift());
