import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsonRecord } from "../server/core/json-core.ts";
import { configDirOverride, resolveHomeDir } from "../server/core/claude-config-paths-core.ts";
import { isRecord, positiveNumberOr, textOr } from "../shared/coerce.ts";
import type { ChildProcess } from "node:child_process";

import { configuredAutoCompactWindow } from "./core/auto-compact-window-core.ts";

import { postPayload } from "./loopback-post.ts";
import { readStdin } from "./relay-stdin.ts";
import type { StdinLike } from "./relay-stdin.ts";

import { spawn } from "../server/child-process-safe.ts";

const NO_CHAIN = "-";

interface StdoutLike {
  write(text: string): unknown;
}

function decodeChainCommand(encoded: string | undefined): string | null {
  if (!encoded || encoded === NO_CHAIN) return null;
  try {
    const command = Buffer.from(encoded, "base64").toString("utf8").trim();
    return command || null;
  } catch {
    return null;
  }
}

function fallbackLine(payload: Record<string, unknown> | null): string {
  const parts: string[] = [];
  const modelField = payload?.model;
  const model = isRecord(modelField) ? modelField.display_name : undefined;
  if (typeof model === "string" && model.trim()) parts.push(model.trim());
  const costField = payload?.cost;
  const cost = isRecord(costField) ? costField.total_cost_usd : undefined;
  if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) parts.push(`$${cost.toFixed(2)}`);
  return parts.join("  ");
}

function readSettingsFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function projectDirOf(payload: Record<string, unknown>): string {
  const workspace = isRecord(payload.workspace) ? payload.workspace : {};
  return textOr(workspace.project_dir, null) ?? textOr(payload.cwd, null) ?? process.cwd();
}

function claudeHomeOf(env: NodeJS.ProcessEnv): string {
  return configDirOverride(env) || path.join(resolveHomeDir(env, os.homedir()) ?? os.homedir(), ".claude");
}

function postBodyOf(raw: Buffer, payload: Record<string, unknown> | null, env: NodeJS.ProcessEnv): Buffer {
  const context = isRecord(payload?.context_window) ? payload.context_window : null;
  const modelWindow = positiveNumberOr(context?.context_window_size, null);
  if (payload === null || context === null || modelWindow === null) return raw;
  const projectSettingsDir = path.join(projectDirOf(payload), ".claude");
  const model = isRecord(payload.model) ? payload.model : {};
  const autoCompactWindow = configuredAutoCompactWindow({
    envWindow: env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    settingsByPrecedence: [
      path.join(projectSettingsDir, "settings.local.json"),
      path.join(projectSettingsDir, "settings.json"),
      path.join(claudeHomeOf(env), "settings.json"),
    ].map(readSettingsFile),
    modelId: textOr(model.id, null),
  });
  if (autoCompactWindow === null || autoCompactWindow >= modelWindow) return raw;
  return Buffer.from(JSON.stringify({ ...payload, context_window: { ...context, context_window_size: autoCompactWindow } }), "utf8");
}

function runChain(command: string, stdinBody: Buffer): Promise<number> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, { shell: true, stdio: ["pipe", "inherit", "inherit"] });
    } catch {
      resolve(0);
      return;
    }
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      resolve(typeof code === "number" ? code : 0);
    };
    child.on("error", () => finish(0));
    child.on("close", (code) => finish(code));
    child.stdin?.on("error", () => {});
    try {
      child.stdin?.end(stdinBody);
    } catch {
    }
  });
}

async function main(
  argv: (string | undefined)[] = process.argv.slice(2),
  stdin: StdinLike = process.stdin,
  stdout: StdoutLike = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const [postUrl, chainEncoded] = argv;
  const raw = await readStdin(stdin);
  const chainCommand = decodeChainCommand(chainEncoded);
  const payload = parseJsonRecord(raw);

  const post = postUrl ? postPayload(postUrl, postBodyOf(raw, payload, env)) : Promise.resolve();
  if (!chainCommand) {
    const line = fallbackLine(payload);
    if (line) stdout.write(`${line}\n`);
    await post;
    return 0;
  }
  const [code] = await Promise.all([runChain(chainCommand, raw), post]);
  return code;
}

if (process.argv[1] === import.meta.filename) {
  main().then((code) => process.exit(code)).catch(() => process.exit(0));
}

export { main, NO_CHAIN };
