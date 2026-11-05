import os from "node:os";
import { runCommandSafely } from "../server/child-process-safe.ts";
import type { GraphicalSessionState } from "./core/spawn-env.ts";

const PROBE_TIMEOUT_MS = 2000;
const PROBE_MAX_BUFFER_BYTES = 4096;

async function probeGraphicalSession(): Promise<GraphicalSessionState> {
  const probe = await runCommandSafely("systemctl", ["--user", "is-active", "graphical-session.target"], {
    cwd: os.homedir(),
    env: process.env,
    timeoutMs: PROBE_TIMEOUT_MS,
    maxBufferBytes: PROBE_MAX_BUFFER_BYTES,
  });
  const reportedState = probe.stdout.trim();
  if (reportedState === "active") return "active";
  if (reportedState === "inactive") return "inactive";
  return "unknown";
}

export { probeGraphicalSession };
