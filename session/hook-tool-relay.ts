import { SANE_YOLO_PATH_ENV, saneYoloHostFlag, saneYoloHostPayload } from "./core/sane-yolo.ts";

import { PACK_HOOK_FILES_ENV, PACK_HOOK_RELAY_BUDGET_MS, PACK_HOOK_RELAY_TOOL_ID, hooksForCall, packHookDenyOutput, packHookDenyReason, packHookFilesOf, packHookInputOf, resolvedPackHooksOf } from "./core/pack-hook-core.ts";
import type { ResolvedPackHook } from "./core/pack-hook-core.ts";
import type { PackHookInput } from "../shared/contracts/pack.ts";
import { clock } from "../shared/clock.ts";
import { readStdin } from "./relay-stdin.ts";
import type { StdinLike } from "./relay-stdin.ts";

import fs from "node:fs";
import { spawn } from "../server/child-process-safe.ts";
import { scriptLaunch } from "../server/runtime-paths.ts";

const HOOK_TOOL_TIMEOUT_MS = 3000;
const MAX_HOOK_TOOL_STDOUT_BYTES = 65536;
const MAX_PACK_HOOK_STDERR_BYTES = 16384;
const PACK_HOOK_BLOCK_EXIT_CODE = 2;

interface StdoutLike {
  write(text: string): unknown;
}

function runHookTool(binPath: string, body: Buffer, agentFlavor = ""): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const done = (text: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(text);
    };
    let child: ReturnType<typeof spawn>;
    try {
      const [launcher, ...launchArguments] = scriptLaunch(binPath, "cc-safety-net", process.execPath);
      child = spawn(launcher, [...launchArguments, "hook", saneYoloHostFlag(agentFlavor)], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      done("");
      return;
    }
    const childStdout = child.stdout;
    const childStdin = child.stdin;
    if (!childStdout || !childStdin) {
      try { child.kill(); } catch {}
      done("");
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done("");
    }, HOOK_TOOL_TIMEOUT_MS);
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    childStdout.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > MAX_HOOK_TOOL_STDOUT_BYTES) {
        try { child.kill(); } catch {}
        done("");
        return;
      }
      chunks.push(bytes);
    });
    childStdout.on("error", () => done(""));
    child.on("error", () => done(""));
    child.on("close", (code) => done(code === 0 ? Buffer.concat(chunks).toString("utf8") : ""));
    childStdin.on("error", () => {});
    try {
      childStdin.end(saneYoloHostPayload(agentFlavor, body));
    } catch {
      done("");
    }
  });
}

type PackHookOutcome = { isBlocked: boolean; stderrText: string };

function runPackHook(hook: ResolvedPackHook, input: PackHookInput): Promise<PackHookOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const done = (outcome: PackHookOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(outcome);
    };
    const allowed: PackHookOutcome = { isBlocked: false, stderrText: "" };
    let child: ReturnType<typeof spawn>;
    try {
      const [program = "", ...programArguments] = hook.argv;
      child = spawn(program, programArguments, { cwd: input.cwd, stdio: ["pipe", "ignore", "pipe"] });
    } catch {
      done(allowed);
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done(allowed);
    }, hook.timeoutMs);
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= MAX_PACK_HOOK_STDERR_BYTES) return;
      const bytes = Buffer.from(chunk);
      stderrBytes += bytes.length;
      stderrChunks.push(bytes);
    });
    child.stderr?.on("error", () => {});
    child.on("error", () => done(allowed));
    child.on("close", (code) => done({ isBlocked: code === PACK_HOOK_BLOCK_EXIT_CODE, stderrText: Buffer.concat(stderrChunks).toString("utf8") }));
    child.stdin?.on("error", () => {});
    try {
      child.stdin?.end(JSON.stringify(input));
    } catch {
      done(allowed);
    }
  });
}

function readPackHooksFile(hooksFilePath: string): ResolvedPackHook[] {
  try {
    return resolvedPackHooksOf(fs.readFileSync(hooksFilePath, "utf8"), hooksFilePath);
  } catch {
    return [];
  }
}

async function runPackHooks(
  agentFlavor: string,
  env: Record<string, string | undefined>,
  stdin: StdinLike,
  stdout: StdoutLike,
  runner: (hook: ResolvedPackHook, input: PackHookInput) => Promise<PackHookOutcome>,
): Promise<{ code: number; reason: string }> {
  const hookFiles = packHookFilesOf(env[PACK_HOOK_FILES_ENV]);
  if (hookFiles.length === 0) return { code: 0, reason: "no-pack-hooks" };
  const body = await readStdin(stdin);
  const payload: unknown = (() => {
    try { return JSON.parse(body.toString("utf8")); } catch { return null; }
  })();
  const input = packHookInputOf(agentFlavor, payload, process.cwd());
  if (input === null) return { code: 0, reason: "no-tool-call" };
  const budgetEndsAt = clock.nowMs() + PACK_HOOK_RELAY_BUDGET_MS;
  for (const hook of hooksForCall(hookFiles.flatMap(readPackHooksFile), input.tool.kind)) {
    const remainingBudgetMs = budgetEndsAt - clock.nowMs();
    if (remainingBudgetMs <= 0) return { code: 0, reason: "over-budget" };
    const outcome = await runner({ ...hook, timeoutMs: Math.min(hook.timeoutMs, remainingBudgetMs) }, input);
    if (!outcome.isBlocked) continue;
    try { stdout.write(packHookDenyOutput(agentFlavor, packHookDenyReason(hook, outcome.stderrText))); } catch {}
    return { code: 0, reason: "denied" };
  }
  return { code: 0, reason: "allowed" };
}

async function main(
  toolId: string = process.argv[2] ?? "",
  env: Record<string, string | undefined> = process.env,
  stdin: StdinLike = process.stdin,
  stdout: StdoutLike = process.stdout,
  runner: (binPath: string, body: Buffer) => Promise<string> = (binPath, body) => runHookTool(binPath, body, agentFlavor),
  agentFlavor: string = process.argv[3] ?? "",
): Promise<{ code: number; reason: string }> {
  if (toolId === PACK_HOOK_RELAY_TOOL_ID) return runPackHooks(agentFlavor, env, stdin, stdout, runPackHook);
  if (toolId !== "saneYolo") return { code: 0, reason: "unknown-tool" };
  const configuredPath = env[SANE_YOLO_PATH_ENV];
  const binPath = typeof configuredPath === "string" ? configuredPath.trim() : "";
  if (!binPath) return { code: 0, reason: "no-tool-path" };
  const body = await readStdin(stdin);
  if (body.length === 0) return { code: 0, reason: "empty-payload" };
  const toolOutput = await runner(binPath, body);
  if (!toolOutput) return { code: 0, reason: "no-response" };
  try { stdout.write(toolOutput); } catch {}
  return { code: 0, reason: "forwarded" };
}

if (process.argv[1] === import.meta.filename) {
  main().then((result) => process.exit(result.code)).catch(() => process.exit(0));
}

export { main, runHookTool };
