import fsp from 'node:fs/promises';
import os from 'node:os';

import { runCommandSafely } from './child-process-safe.ts';
import {
  knownToolDirs,
  loginShellPathScript,
  mergePathEntries,
  parseLoginShellPath,
  splitPathEntries,
  toolCandidatePaths,
} from './git/core/dependency-clone-core.ts';

type InstallPathSource = 'server' | 'login-shell' | 'known-dir';
type ResolvedTool = { name: string; path: string | null; source: InstallPathSource | null };
type InstallPath = { extraPathEntries: string[]; searchedPathEntries: string[]; tools: ResolvedTool[] };

const LOGIN_SHELL_TIMEOUT_MS = 5_000;
const LOGIN_SHELL_OUTPUT_MAX_BYTES = 1024 * 1024;

let loginShellPathEntries: Promise<string[]> | null = null;
const resolvedToolsByName = new Map<string, Promise<ResolvedTool>>();

async function firstExecutable(candidatePaths: readonly string[]): Promise<string | null> {
  for (const candidatePath of candidatePaths) {
    const isExecutable = await fsp.access(candidatePath, fsp.constants.X_OK).then(() => true, () => false);
    if (isExecutable) return candidatePath;
  }
  return null;
}

function defaultLoginShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  if (process.platform === 'darwin') return '/bin/zsh';
  return '/bin/sh';
}

async function readLoginShellPath(): Promise<string[]> {
  if (process.platform === 'win32') return [];
  const shell = defaultLoginShell();
  const run = await runCommandSafely(shell, ['-ilc', loginShellPathScript()], {
    cwd: os.homedir(),
    env: process.env,
    timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
    maxBufferBytes: LOGIN_SHELL_OUTPUT_MAX_BYTES,
  });
  const entries = parseLoginShellPath(run.stdout);
  if (entries) return entries;
  console.log(`[install-path] could not read the PATH of login shell ${shell}${run.wasKilled ? ` within ${LOGIN_SHELL_TIMEOUT_MS}ms` : ''}; searching known folders only`);
  return [];
}

function loginShellPath(): Promise<string[]> {
  loginShellPathEntries ??= readLoginShellPath().then((entries) => {
    if (!entries.length) loginShellPathEntries = null;
    return entries;
  });
  return loginShellPathEntries;
}

function serverPathEntries(): string[] {
  return splitPathEntries(process.env.PATH ?? '');
}

function knownDirs(): string[] {
  return knownToolDirs({ platform: process.platform, env: process.env, homedir: os.homedir() });
}

async function resolveTool(toolName: string): Promise<ResolvedTool> {
  const onServerPath = await firstExecutable(toolCandidatePaths(toolName, serverPathEntries(), process.platform));
  if (onServerPath) return { name: toolName, path: onServerPath, source: 'server' };
  const onLoginShellPath = await firstExecutable(toolCandidatePaths(toolName, await loginShellPath(), process.platform));
  if (onLoginShellPath) return { name: toolName, path: onLoginShellPath, source: 'login-shell' };
  const inKnownDir = await firstExecutable(toolCandidatePaths(toolName, knownDirs(), process.platform));
  if (inKnownDir) return { name: toolName, path: inKnownDir, source: 'known-dir' };
  return { name: toolName, path: null, source: null };
}

function resolvedTool(toolName: string): Promise<ResolvedTool> {
  const known = resolvedToolsByName.get(toolName);
  if (known) return known;
  const resolving = resolveTool(toolName).then((tool) => {
    if (!tool.path) resolvedToolsByName.delete(toolName);
    return tool;
  });
  resolvedToolsByName.set(toolName, resolving);
  return resolving;
}

async function resolveInstallPath(toolNames: readonly string[]): Promise<InstallPath> {
  const tools = await Promise.all([...new Set(toolNames)].map(resolvedTool));
  const serverEntries = serverPathEntries();
  const isEveryToolOnServerPath = tools.every((tool) => tool.source === 'server');
  if (isEveryToolOnServerPath) return { extraPathEntries: [], searchedPathEntries: serverEntries, tools };
  const extraPathEntries = mergePathEntries(await loginShellPath(), knownDirs()).filter((entry) => !serverEntries.includes(entry));
  return { extraPathEntries, searchedPathEntries: mergePathEntries(serverEntries, extraPathEntries), tools };
}

export { resolveInstallPath };
