import fs from 'node:fs';
import path from 'node:path';
import tty from 'node:tty';
import { FilesystemConfigSchema, SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { NetworkConfig, SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { spawn } from '../server/child-process-safe.ts';
import { errorMessage } from '../shared/text.ts';
import { confineToOwnTerminal } from './core/sandbox-terminal-core.ts';

const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const ANY_TERMINAL_SCOPE = 'any';
const DEVICE_FOLDER = '/dev';
const PSEUDO_TERMINAL_PREFIX = 'ttys';

function fieldOf(record: unknown, field: string): unknown {
  if (typeof record !== 'object' || record === null) return undefined;
  return Reflect.get(record, field);
}

function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

interface OpenPolicy {
  runtimeConfig: SandboxRuntimeConfig;
  isAnyTerminalAllowed: boolean;
}

function openNetworkOf(policy: unknown): Partial<NetworkConfig> {
  const network = fieldOf(policy, 'network');
  const machServices = fieldOf(network, 'allowMachLookup');
  const allowMachLookup = Array.isArray(machServices) ? machServices.filter((service): service is string => typeof service === 'string') : [];
  return { allowAllUnixSockets: fieldOf(network, 'allowAllUnixSockets') === true, ...(allowMachLookup.length === 0 ? {} : { allowMachLookup }) };
}

function readOpenPolicy(policyPath: string): OpenPolicy {
  const policy: unknown = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  if (fieldOf(fieldOf(policy, 'network'), 'allowedDomains') !== undefined) throw new Error('a policy with a domain list must run through the sandbox runtime CLI');
  const filesystem = FilesystemConfigSchema.parse(fieldOf(policy, 'filesystem'));
  return {
    runtimeConfig: {
      network: openNetworkOf(policy), filesystem, allowPty: fieldOf(policy, 'allowPty') === true, enableWeakerNetworkIsolation: true, allowAppleEvents: fieldOf(policy, 'allowAppleEvents') === true,
    } as SandboxRuntimeConfig,
    isAnyTerminalAllowed: fieldOf(policy, 'terminalScope') === ANY_TERMINAL_SCOPE,
  };
}

function ownTerminalPath(): string {
  if (!tty.isatty(0)) throw new Error('a policy with terminal access needs the launcher to run in a terminal');
  const ownDevice = fs.fstatSync(0).rdev;
  const ownName = fs.readdirSync(DEVICE_FOLDER)
    .filter((name) => name.startsWith(PSEUDO_TERMINAL_PREFIX))
    .find((name) => fs.statSync(path.join(DEVICE_FOLDER, name)).rdev === ownDevice);
  if (ownName === undefined) throw new Error('the launcher terminal is not a pseudo-terminal under /dev');
  return path.join(DEVICE_FOLDER, ownName);
}

function sandboxArgv(argv: string[], { runtimeConfig, isAnyTerminalAllowed }: OpenPolicy): string[] {
  if (runtimeConfig.allowPty !== true || isAnyTerminalAllowed || process.platform !== 'darwin') return argv;
  const confinement = confineToOwnTerminal(argv, ownTerminalPath());
  if (!confinement.ok) throw new Error(confinement.reason);
  return confinement.argv;
}

function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (signal === null) return code ?? 0;
  return FORWARDED_SIGNALS.some((forwarded) => forwarded === signal) ? 0 : 1;
}

async function launchInOpenNetworkSandbox(): Promise<void> {
  const [policyPath, ...command] = process.argv.slice(2);
  if (!policyPath || command.length === 0) throw new Error('usage: sandbox-open-launcher <policy file> <command> [arguments]');
  const openPolicy = readOpenPolicy(policyPath);
  const dependencies = SandboxManager.checkDependencies();
  const dependencyProblems = [...dependencies.errors, ...dependencies.warnings];
  if (dependencyProblems.length > 0) throw new Error(`the sandbox runtime cannot start: ${dependencyProblems.join('; ')}`);
  const beforeSpawn: { interruptedBy: NodeJS.Signals | null } = { interruptedBy: null };
  const interrupted = new AbortController();
  let child: ReturnType<typeof spawn> | undefined;
  for (const signal of FORWARDED_SIGNALS) {
    process.on(signal, () => {
      if (child !== undefined) {
        child.kill(signal);
        return;
      }
      beforeSpawn.interruptedBy ??= signal;
      interrupted.abort();
    });
  }
  const exitWhenInterrupted = (): void => {
    if (beforeSpawn.interruptedBy !== null) process.exit(exitCodeFor(null, beforeSpawn.interruptedBy));
  };
  await SandboxManager.initialize(openPolicy.runtimeConfig);
  const commandLine = command.map(shellQuote).join(' ');
  const wrapped = await SandboxManager.wrapWithSandboxArgv(commandLine, undefined, undefined, interrupted.signal).catch((wrapFailure: unknown) => {
    exitWhenInterrupted();
    throw wrapFailure;
  });
  const [shell, ...shellArgs] = sandboxArgv(wrapped.argv, openPolicy);
  if (!shell || shellArgs.at(-1) === commandLine) throw new Error('the sandbox runtime returned the command unwrapped');
  exitWhenInterrupted();
  child = spawn(shell, shellArgs, { stdio: 'inherit', env: wrapped.env });
  child.on('error', (error) => {
    console.error(`sandbox launcher: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    SandboxManager.cleanupAfterCommand();
    process.exit(exitCodeFor(code, signal));
  });
}

launchInOpenNetworkSandbox().catch((error: unknown) => {
  console.error(`sandbox launcher: ${errorMessage(error)}`);
  process.exit(1);
});
