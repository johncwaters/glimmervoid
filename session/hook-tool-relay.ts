import { SANE_YOLO_PATH_ENV } from "./core/sane-yolo.ts";
import type { HookToolId } from "./core/hook-tools.ts";

import { readStdin } from "./relay-stdin.ts";
import type { StdinLike } from "./relay-stdin.ts";

import { spawn } from "../server/child-process-safe.ts";

import { MAX_RTK_STDOUT_BYTES, RTK_PATH_ENV, normalizeRtkHookResponse } from "./core/rtk-hook-core.ts";

const RTK_TIMEOUT_MS = 3000;

interface StdoutLike {
  write(text: string): unknown;
}

function runHookTool(toolId: HookToolId, binPath: string, body: Buffer): Promise<string> {
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
      const command = toolId === "rtk" ? binPath : process.execPath;
      const args = toolId === "rtk" ? ["hook", "claude"] : [binPath, "hook", "--grok-build"];
      child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
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
    }, RTK_TIMEOUT_MS);
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    childStdout.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > MAX_RTK_STDOUT_BYTES) {
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
      childStdin.end(body);
    } catch {
      done("");
    }
  });
}

async function main(
  toolId: string = process.argv[2] ?? "",
  env: Record<string, string | undefined> = process.env,
  stdin: StdinLike = process.stdin,
  stdout: StdoutLike = process.stdout,
  runner: (binPath: string, body: Buffer) => Promise<string> = (binPath, body) => runHookTool(toolId === "rtk" ? "rtk" : "saneYolo", binPath, body),
): Promise<{ code: number; reason: string }> {
  if (toolId !== "rtk" && toolId !== "saneYolo") return { code: 0, reason: "unknown-tool" };
  const configuredPath = env[toolId === "rtk" ? RTK_PATH_ENV : SANE_YOLO_PATH_ENV];
  const binPath = typeof configuredPath === "string" ? configuredPath.trim() : "";
  if (!binPath) return { code: 0, reason: "no-tool-path" };
  const body = await readStdin(stdin);
  if (body.length === 0) return { code: 0, reason: "empty-payload" };
  const toolOutput = await runner(binPath, body);
  const response = toolId === "rtk" ? normalizeRtkHookResponse(toolOutput) : toolOutput;
  if (!response) return { code: 0, reason: "no-response" };
  try { stdout.write(toolId === "rtk" ? `${response}\n` : response); } catch {}
  return { code: 0, reason: "forwarded" };
}

if (process.argv[1] === import.meta.filename) {
  main().then((result) => process.exit(result.code)).catch(() => process.exit(0));
}

function runRtk(binPath: string, body: Buffer): Promise<string> {
  return runHookTool("rtk", binPath, body);
}

export { main, runRtk, runHookTool, RTK_TIMEOUT_MS };
