#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AGENT_API_VERBS } from '../shared/contracts/session.ts';
import type { CustomAgentDeclaration } from '../shared/contracts/config.ts';
import { execSync } from '../server/child-process-safe.ts';
import { renderTable } from '../server/core/ascii-figure-core.ts';
import { decideConfigPath, glimmervoidHomeDir } from '../server/core/config-path-core.ts';
import { nodePtyRebuildHint } from '../server/core/node-pty-preflight-core.ts';
import { probeNodePty } from '../server/node-pty-preflight.ts';
import { sandboxDoctorRows } from '../server/core/sandbox-deps-core.ts';
import { probeSandboxDependencies } from '../server/sandbox-deps.ts';
import { packageRoot } from '../server/runtime-paths.ts';
import { formatPathNotice, npmGlobalBinDir, onPath, pnpmGlobalBinDir } from './path-doctor.ts';

const args = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { version: string };

const USAGE = `Usage: glimmervoid [command] [options]

Commands:
  doctor            Diagnose install / PATH issues and exit
  agent setup grok  Install Glimmervoid's env-inert Grok hook relay
  pair              Mint a single-use pairing link for a remote device
  pair --list       List paired devices
  pair --revoke <id>  Revoke a paired device
  visions relay     Run the Visions LSP relay on stdio (what an editor's LSP client spawns)
  visions install   Install the Visions extension into every VS Code family editor on PATH
  visions setup     Print LSP client config for Neovim, Helix, Emacs, Kate, Sublime, JetBrains
  visions status    Report the relay path and which editors carry the extension
  spawn <prompt>    From inside a Glimmervoid session, start a sibling session on that prompt
  attention <note>  From inside a Glimmervoid session, flag it as needing the operator
  board             From inside a Glimmervoid session, list the live sessions

Options:
  --name <label>    Label for the device being paired (with: pair)
  --port <number>   Override the server port (default: 3000)
  --config <path>   Path to config file (default: ~/.glimmervoid/config.json)
  --version         Show version number
  --help, -h        Show this help message`;

if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

if (args.includes('--version')) {
  console.log(pkg.version);
  process.exit(0);
}

function getArgValue(flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return null;
}

const configArg = getArgValue('--config');
if (configArg) {
  process.env.GLIMMERVOID_CONFIG = configArg;
}

const portArg = getArgValue('--port');
if (portArg) {
  process.env.GLIMMERVOID_PORT = portArg;
}

type SubcommandRunner = (commandArgs: string[]) => Promise<number>;

const SUBCOMMAND_RUNNERS = new Map<string, SubcommandRunner>([
  ['doctor', async () => {
    await runDoctor();
    return 0;
  }],
  ['pair', async (commandArgs) => {
    const { runPairCli } = await import('../server/pair-cli.ts');
    return runPairCli(commandArgs.slice(1));
  }],
  ['agent', async (commandArgs) => {
    const { runAgentSetupCli } = await import('../server/agent-setup-cli.ts');
    return runAgentSetupCli(commandArgs.slice(1));
  }],
  ['visions', async (commandArgs) => {
    const { runVisionsCli } = await import('../server/visions-cli.ts');
    return runVisionsCli(commandArgs.slice(1));
  }],
  ...AGENT_API_VERBS.map((verb): [string, SubcommandRunner] => [verb, async (commandArgs) => {
    const { runAgentApiCli } = await import('../server/agent-api-cli.ts');
    return runAgentApiCli(commandArgs);
  }]),
]);

async function dispatchCommandLine(): Promise<void> {
  const requestedSubcommand = args.includes('--doctor') ? 'doctor' : args[0];
  if (!requestedSubcommand || requestedSubcommand.startsWith('-')) {
    await import('../server/index.ts');
    return;
  }
  const runSubcommand = SUBCOMMAND_RUNNERS.get(requestedSubcommand);
  if (!runSubcommand) {
    console.error(`Unknown command: ${requestedSubcommand}\n${USAGE}`);
    process.exit(1);
  }
  try {
    process.exit(await runSubcommand(args));
  } catch (err) {
    console.error(messageOf(err));
    process.exit(1);
  }
}

await dispatchCommandLine();

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function firstLineOf(error: unknown): string {
  return messageOf(error).split('\n')[0];
}

function decideReadOnlyConfigPath(): ReturnType<typeof decideConfigPath> {
  return decideConfigPath({
    env: process.env,
    homeDir: glimmervoidHomeDir(os.homedir(), process.env),
  }, (candidate) => fs.existsSync(candidate));
}

function resolveConfigPathReadOnly(): string {
  const decided = decideReadOnlyConfigPath();
  if (decided.path) return decided.path;
  if (decided.source === 'env') return `${decided.envPath} (set via GLIMMERVOID_CONFIG, but NOT found)`;
  return `${decided.homePath} (created on first run)`;
}

async function readDeclaredCustomAgents(): Promise<{ declared: readonly CustomAgentDeclaration[]; error: string | null }> {
  const decided = decideReadOnlyConfigPath();
  if (!decided.path) return { declared: [], error: null };
  const { loadConfigFile } = await import('../server/config-store.ts');
  try {
    const loaded = loadConfigFile(decided.path, { exitOnError: false });
    if (!loaded.config) return { declared: [], error: loaded.message };
    return { declared: loaded.config.customAgents ?? [], error: null };
  } catch (err) {
    return { declared: [], error: `could not read ${decided.path}: ${firstLineOf(err)}` };
  }
}

async function runDoctor(): Promise<void> {
  const platform = process.platform;
  const homedir = os.homedir();
  const pathEnv = process.env.PATH || process.env.Path || '';
  let section = 'Versions';
  let rows: string[][] = [];
  const line = (label: string, value: string) => rows.push([label, value]);
  const flush = () => {
    console.log(renderTable({ title: section, rows, terminalColumns: process.stdout.columns }));
    rows = [];
  };
  const switchSection = (nextSection: string) => {
    flush();
    console.log('');
    section = nextSection;
  };

  console.log('glimmervoid doctor\n');

  line('glimmervoid', pkg.version);
  line('node', process.version);
  line('platform', `${platform} ${process.arch}`);

  switchSection('This CLI');
  line('running from', process.argv[1] || '(unknown)');
  line('package dir', packageRoot);

  switchSection('PATH registration');

  const envNpmBin = npmGlobalBinDir({ env: process.env, platform, homedir });
  const npmBin = envNpmBin || npmGlobalBinDir({ env: process.env, platform, homedir, resolvedPrefix: resolveNpmGlobalPrefix(execSync) });
  const npmOn = npmBin ? onPath(npmBin, { pathEnv, platform }) : false;
  line('npm global bin', npmBin || '(unknown)');
  line('on PATH', npmBin ? (npmOn ? 'yes' : 'NO') : 'unknown');
  const pnpmBin = pnpmGlobalBinDir({ env: process.env, platform, homedir });
  if (pnpmBin && fs.existsSync(pnpmBin)) {
    line('pnpm global bin', pnpmBin);
    line('on PATH', onPath(pnpmBin, { pathEnv, platform }) ? 'yes' : 'NO');
  }

  switchSection('Agents');

  try {
    const { listAgentIds, describeAgentResolvability, setCustomAgents } = await import('../session/adapters/index.ts');
    const declaredCustomAgents = await readDeclaredCustomAgents();
    if (declaredCustomAgents.error) line('config', declaredCustomAgents.error);
    setCustomAgents(declaredCustomAgents.declared);
    for (const id of listAgentIds()) {
      const { label, path: resolvedPath } = describeAgentResolvability(id);
      line(`${id} (${label})`, resolvedPath ?? 'not found on PATH');
    }
    const { inspectGrokAgentSetup } = await import('../server/agent-setup-cli.ts');
    const grokSetup = inspectGrokAgentSetup();
    line('grok hook setup', `${grokSetup.classification}: ${grokSetup.filePath}`);
  } catch (err) {
    line('agents', `probe failed: ${firstLineOf(err)}`);
  }

  switchSection('rtk');
  try {
    const { getRtkPath } = await import('../server/rtk-resolver.ts');
    const rtkPath = getRtkPath();
    line('rtk', rtkPath || 'not installed (Glimmervoid installs it when the rtk setting is on)');
  } catch (err) {
    line('rtk', `probe failed: ${firstLineOf(err)}`);
  }

  switchSection('Native module');
  const nodePty = await probeNodePty();
  if (nodePty.ok) line('node-pty', 'loads OK');
  if (!nodePty.ok) {
    line('node-pty', 'FAILED to load');
    line('reason', nodePty.reason);
    line('hint', nodePtyRebuildHint(platform));
  }

  switchSection('Sandbox');
  for (const [label, value] of sandboxDoctorRows(probeSandboxDependencies({ platform, exec: execSync }))) line(label, value);

  switchSection('Config');
  line('resolved config', resolveConfigPathReadOnly());
  flush();

  if (npmBin && !npmOn) {
    console.log(`\n${formatPathNotice({ installedBinDir: npmBin, onPathFlag: false, platform })}`);
  }
}

function resolveNpmGlobalPrefix(exec: typeof execSync): string | null {
  try {
    const out = exec('npm prefix -g', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    const prefix = String(out || '').trim();
    if (prefix) return prefix;
  } catch {
    return null;
  }
  return null;
}
