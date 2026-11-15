import type { SpawnEnv } from "./spawn-env.ts";

const SESSION_SCOPE_COMMAND = "systemd-run";
const SESSION_SCOPE_SLICE = "app-glimmervoid-sessions.slice";
const SESSION_BUS_ENV = "DBUS_SESSION_BUS_ADDRESS";
const SCOPE_BASE_ARGS = ["--user", "--scope", "--quiet", "--collect", `--slice=${SESSION_SCOPE_SLICE}`, "-p", "CPUWeight=100"];
const RESOURCE_CAP_FILES = ["memory.high", "memory.max"] as const;
const UNCAPPED = "max";

interface ScopedLaunchInput {
  unitName: string;
  serverUnit: string | null;
  file: string;
  args: string[];
  env: SpawnEnv;
}

interface ScopedLaunch {
  file: string;
  args: string[];
  env: SpawnEnv;
}

function sessionScopeUnitName(sessionId: string, nonce: string): string {
  return `glimmervoid-session-${sessionId}-${nonce}.scope`;
}

function bindToServerArgs(serverUnit: string | null): string[] {
  if (serverUnit === null) return [];
  return ["-p", `BindsTo=${serverUnit}`, "-p", `After=${serverUnit}`];
}

function sessionScopeProbeArgs(serverUnit: string | null): string[] {
  return [...SCOPE_BASE_ARGS, ...bindToServerArgs(serverUnit), "--", "true"];
}

function cgroupPathOf(procSelfCgroup: string): string | null {
  const unifiedEntry = procSelfCgroup.split("\n").find((line) => line.startsWith("0::"));
  return unifiedEntry === undefined ? null : unifiedEntry.slice(3).trim();
}

function userServiceUnitOf(cgroupPath: string): string | null {
  const segments = cgroupPath.split("/");
  const leaf = segments.at(-1) ?? "";
  const isInsideUserManager = segments.slice(0, -1).some((segment) => /^user@\d+\.service$/.test(segment));
  if (!isInsideUserManager || !leaf.endsWith(".service")) return null;
  return leaf;
}

function cappedResourcesOf(capValueByFile: Partial<Record<(typeof RESOURCE_CAP_FILES)[number], string>>): string[] {
  return RESOURCE_CAP_FILES.filter((file) => {
    const capValue = capValueByFile[file];
    return capValue !== undefined && capValue.trim() !== UNCAPPED;
  });
}

function withoutSessionBus(env: SpawnEnv): SpawnEnv {
  const envForSystemdRun = { ...env };
  delete envForSystemdRun[SESSION_BUS_ENV];
  return envForSystemdRun;
}

function scopedLaunch({ unitName, serverUnit, file, args, env }: ScopedLaunchInput): ScopedLaunch {
  const agentSessionBus = env[SESSION_BUS_ENV];
  const sessionBusArgs = agentSessionBus === undefined ? [] : ["-E", `${SESSION_BUS_ENV}=${agentSessionBus}`];
  return {
    file: SESSION_SCOPE_COMMAND,
    args: [...SCOPE_BASE_ARGS, `--unit=${unitName}`, ...bindToServerArgs(serverUnit), ...sessionBusArgs, "--", file, ...args],
    env: withoutSessionBus(env),
  };
}

export {
  RESOURCE_CAP_FILES,
  SESSION_SCOPE_COMMAND,
  SESSION_SCOPE_SLICE,
  cappedResourcesOf,
  cgroupPathOf,
  scopedLaunch,
  sessionScopeProbeArgs,
  sessionScopeUnitName,
  userServiceUnitOf,
  withoutSessionBus,
};
