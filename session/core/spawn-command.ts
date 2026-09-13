import path from "node:path";

type PathLookupOptions = { encoding: 'utf8'; stdio: ['ignore', 'pipe', 'ignore']; timeout: number };

type PathLookupExec = (command: string, options: PathLookupOptions) => string;

type PathLookupExecFile = (file: string, args: readonly string[], options: PathLookupOptions) => string;

type CommandKind = "exe" | "shim" | "unresolved";

interface ResolvedCommand {
  path: string | null;
  kind: string;
}

function classifyCommandKind(resolvedPath: string | null | undefined): CommandKind {
  if (!resolvedPath) return "unresolved";
  const ext = (resolvedPath.match(/\.[^.\\/]+$/) || [""])[0].toLowerCase();
  return ext === ".exe" || ext === ".com" ? "exe" : "shim";
}

function dedupePathMatches(
  matches: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of matches) {
    let normalized = pathApi.normalize(candidate.trim());
    if (normalized.length > 1) normalized = normalized.replace(/[\\/]+$/, "");
    const key = platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(normalized);
  }
  return unique;
}

const PATH_PROBE_OPTIONS: PathLookupOptions = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  timeout: 2000,
};

interface PathProbe {
  shellCommand: string;
  file: string;
  args: readonly string[];
}

function pathProbesFor(name: string, platform: NodeJS.Platform): PathProbe[] {
  if (platform === "win32") {
    return [{ shellCommand: `where ${name}`, file: "where", args: [name] }];
  }
  return [
    { shellCommand: `which -a ${name}`, file: "which", args: ["-a", name] },
    { shellCommand: `sh -c "command -v ${name}"`, file: "sh", args: ["-c", 'command -v "$1"', "sh", name] },
  ];
}

function resolveCommandMatches(
  name: string,
  { platform, runProbe }: { platform: NodeJS.Platform; runProbe: (probe: PathProbe) => string },
): string[] {
  for (const probe of pathProbesFor(name, platform)) {
    let matches: string[] = [];
    try {
      const output = runProbe(probe);
      matches = dedupePathMatches(output.split(/\r?\n/).filter((line) => line.trim()), platform);
    } catch {
      matches = [];
    }
    if (matches.length > 0) return matches;
  }
  return [];
}

function resolvePathCommandMatches(
  name: string,
  { platform, exec }: { platform: NodeJS.Platform; exec: PathLookupExec },
): string[] {
  return resolveCommandMatches(name, {
    platform,
    runProbe: (probe) => exec(probe.shellCommand, PATH_PROBE_OPTIONS),
  });
}

function resolveArgvCommandMatches(
  name: string,
  { platform, execFile }: { platform: NodeJS.Platform; execFile: PathLookupExecFile },
): string[] {
  return resolveCommandMatches(name, {
    platform,
    runProbe: (probe) => execFile(probe.file, probe.args, PATH_PROBE_OPTIONS),
  });
}

function isAbsoluteCommandPath(name: string, platform: NodeJS.Platform): boolean {
  return (platform === "win32" ? path.win32 : path.posix).isAbsolute(name);
}

function resolveAgentCommand(
  { name, platform = process.platform, execFile, pathExists }:
    {
      name: string;
      platform?: NodeJS.Platform;
      execFile?: PathLookupExecFile;
      pathExists?: (candidate: string) => boolean;
    },
): ResolvedCommand {
  if (isAbsoluteCommandPath(name, platform)) {
    if (typeof pathExists !== "function") {
      throw new TypeError("resolveAgentCommand requires a pathExists probe for an absolute command");
    }
    if (pathExists(name)) return { path: name, kind: classifyCommandKind(name) };
    console.warn(`[glimmervoid] could not resolve '${name}'`);
    return { path: null, kind: "unresolved" };
  }
  if (typeof execFile !== "function") throw new TypeError("resolveAgentCommand requires an execFile function");
  const matches = resolveArgvCommandMatches(name, { platform, execFile });
  if (matches.length === 0) {
    console.warn(`[glimmervoid] could not resolve '${name}'`);
    return { path: null, kind: "unresolved" };
  }
  const resolvedPath = matches[0];

  if (process.env.GLIMMERVOID_DEBUG_SPAWN) {
    console.log(`[glimmervoid] resolved '${name}' (first match wins): ${resolvedPath}`);
  }
  if (matches.length > 1) {
    console.warn(
      `[glimmervoid] multiple '${name}' on PATH (Bun shim risk):\n  ${matches.join("\n  ")}`,
    );
  }
  const kind = classifyCommandKind(resolvedPath);
  if (platform === "win32") {
    console.log(
      `[glimmervoid] ${name} spawn strategy: ${kind === "exe" ? "direct exe" : "cmd.exe shim fallback"}`,
    );
  }
  return { path: resolvedPath, kind };
}

function buildAgentSpawnCommand(
  { name, platform, resolved, argGroups = [] }: {
    name: string;
    platform: NodeJS.Platform;
    resolved?: ResolvedCommand | null;
    argGroups?: (string[] | null | undefined)[];
  },
): { file: string; args: string[] } {
  const childArgs = argGroups.flatMap((group) => group || []);
  if (platform !== "win32") {
    return { file: name, args: childArgs };
  }
  if (resolved && resolved.kind === "exe" && resolved.path) {
    return { file: resolved.path, args: childArgs };
  }

  return { file: "cmd.exe", args: ["/c", name, ...childArgs] };
}

export {
  classifyCommandKind,
  dedupePathMatches,
  resolvePathCommandMatches,
  resolveAgentCommand,
  buildAgentSpawnCommand,
};
export type { CommandKind, PathLookupExec, PathLookupExecFile, PathLookupOptions, ResolvedCommand };
