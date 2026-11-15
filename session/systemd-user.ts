import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandSafely } from "../server/child-process-safe.ts";
import { clock } from "../shared/clock.ts";
import {
  RESOURCE_CAP_FILES,
  SESSION_SCOPE_COMMAND,
  SESSION_SCOPE_SLICE,
  cappedResourcesOf,
  cgroupPathOf,
  sessionScopeProbeArgs,
  userServiceUnitOf,
  withoutSessionBus,
} from "./core/session-scope-core.ts";
import type { GraphicalSessionState } from "./core/spawn-env.ts";

const PROBE_TIMEOUT_MS = 2000;
const PROBE_MAX_BUFFER_BYTES = 4096;
const SCOPE_PROBE_TIMEOUT_MS = 5000;
const SCOPE_PROBE_RETRY_MS = 60_000;
const SCOPE_STOP_TIMEOUT_MS = 3000;
const CGROUP_ROOT = "/sys/fs/cgroup";

interface SessionScopeHost {
  serverUnit: string | null;
}

interface SessionScopeVerdict {
  host: SessionScopeHost | null;
  retryAtMs: number;
}

let sessionScopeVerdict: Promise<SessionScopeVerdict> | null = null;
let hasLoggedScopesOff = false;

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

function logScopesOff(reason: string): void {
  if (hasLoggedScopesOff) return;
  hasLoggedScopesOff = true;
  console.warn(`[session-scope] off, sessions share the server's cgroup: ${reason}`);
}

async function readCapValue(cgroupPath: string, capFile: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path.join(CGROUP_ROOT, cgroupPath, capFile), "utf8");
  } catch {
    return undefined;
  }
}

async function decideSessionScopes(): Promise<SessionScopeVerdict> {
  const cgroupPath = cgroupPathOf(await fs.readFile("/proc/self/cgroup", "utf8").catch(() => ""));
  const serverUnit = cgroupPath === null ? null : userServiceUnitOf(cgroupPath);
  if (cgroupPath !== null && serverUnit !== null) {
    const capValues = await Promise.all(RESOURCE_CAP_FILES.map((capFile) => readCapValue(cgroupPath, capFile)));
    const cappedResources = cappedResourcesOf(Object.fromEntries(RESOURCE_CAP_FILES.map((capFile, index) => [capFile, capValues[index]])));
    if (cappedResources.length > 0) {
      logScopesOff(`${serverUnit} caps ${cappedResources.join(", ")} on itself, which a session scope would escape; move MemoryHigh= and MemoryMax= to app-glimmervoid.slice and set Slice=app-glimmervoid.slice on ${serverUnit}, as session/remote-setup does, so they cover ${SESSION_SCOPE_SLICE} too`);
      return { host: null, retryAtMs: Number.POSITIVE_INFINITY };
    }
  }
  const probe = await runCommandSafely(SESSION_SCOPE_COMMAND, sessionScopeProbeArgs(serverUnit), {
    cwd: os.homedir(),
    env: withoutSessionBus(process.env),
    timeoutMs: SCOPE_PROBE_TIMEOUT_MS,
    maxBufferBytes: PROBE_MAX_BUFFER_BYTES,
  });
  if (probe.ok) return { host: { serverUnit }, retryAtMs: Number.POSITIVE_INFINITY };
  logScopesOff(`${SESSION_SCOPE_COMMAND} --user --scope failed: ${probe.stderr.trim() || probe.failureCode || `exit ${probe.exitCode}`}`);
  return { host: null, retryAtMs: clock.nowMs() + SCOPE_PROBE_RETRY_MS };
}

async function resolveSessionScopeHost(): Promise<SessionScopeHost | null> {
  if (process.platform !== "linux") return null;
  const cachedVerdict = sessionScopeVerdict === null ? null : await sessionScopeVerdict;
  if (cachedVerdict !== null && clock.nowMs() < cachedVerdict.retryAtMs) return cachedVerdict.host;
  sessionScopeVerdict = decideSessionScopes();
  return (await sessionScopeVerdict).host;
}

async function stopSessionScope(unitName: string): Promise<void> {
  await runCommandSafely("systemctl", ["--user", "stop", unitName], {
    cwd: os.homedir(),
    env: withoutSessionBus(process.env),
    timeoutMs: SCOPE_STOP_TIMEOUT_MS,
    maxBufferBytes: PROBE_MAX_BUFFER_BYTES,
  });
}

export { probeGraphicalSession, resolveSessionScopeHost, stopSessionScope };
