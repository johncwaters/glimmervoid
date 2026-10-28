#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AGENT_API_VERBS, AGENT_URL_ENV } from '../shared/contracts/session.ts';
import type { CustomAgentDeclaration } from '../shared/contracts/config.ts';
import { execSync } from '../server/child-process-safe.ts';
import { agentCommandHelpLines } from '../server/core/agent-api-core.ts';
import { renderTable } from '../server/core/ascii-figure-core.ts';
import { decideConfigPath, glimmervoidHomeDir } from '../server/core/config-path-core.ts';
import { parseCommandLine } from '../server/core/command-line-core.ts';
import { nodePtyRebuildHint } from '../server/core/node-pty-preflight-core.ts';
import { firstLine } from '../server/core/text-core.ts';
import { errorText } from '../shared/text.ts';
import { probeNodePty } from '../server/node-pty-preflight.ts';
import { guardrailsDoctorRows } from '../server/guardrails/core/guardrails-deps-core.ts';
import { probeGuardrailsDependencies } from '../server/guardrails/guardrails-deps.ts';
import { gitDoctorRows } from '../server/git/core/git-version-core.ts';
import { probeGitVersion } from '../server/git/git-version.ts';
import { packageRoot } from '../server/runtime-paths.ts';
import { formatPathNotice, npmGlobalBinDir, onPath, pnpmGlobalBinDir } from './path-doctor.ts';

const args = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { version: string };

const USAGE = `Usage: glimmervoid [command] [options]

With no command, starts the server.

Commands:
  doctor              Check the install, PATH, agent CLIs and native module, then exit
  settings <cmd>      Read and change config.json: list, get, set, unset, search, schema (each takes --json)
  pair                Mint a single-use pairing link for a remote device
  pair --list         List paired devices
  pair --revoke <id>  Revoke a paired device
  agent setup grok    Install the Grok hook relay, which does nothing outside Glimmervoid

Editor integration (Visions):
  visions install     Install the Visions extension into every VS Code family editor on PATH
  visions uninstall   Remove the Visions extension and the editor config it wrote
  visions setup       Print LSP client config for Neovim, Helix, Emacs, Kate, Sublime, JetBrains
  visions status      Show the relay path and which editors have the extension
  visions relay       Run the Visions LSP relay on stdio (an editor's LSP client starts this)

Inside a Glimmervoid session:
${agentCommandHelpLines().join('\n')}
  ssh-sign            Sign a commit with the operator's forwarded ssh agent (git runs this)

Options:
  --port <number>     Server port (default: 3000)
  --config <path>     Config file (default: ~/.glimmervoid/config.json)
  --name <label>      Name for the device being paired (with pair)
  --no-open           Do not open the dashboard in a browser on first start
  --version           Print the version
  --help, -h          Print this help`;

const commandLine = parseCommandLine(args);

if (commandLine.kind === 'help') {
  console.log(USAGE);
  await printSessionLimits();
  await drainOutput();
  process.exit(0);
}

if (commandLine.kind === 'version') {
  console.log(pkg.version);
  process.exit(0);
}

if (commandLine.globalOptions.configPath) {
  process.env.GLIMMERVOID_CONFIG = commandLine.globalOptions.configPath;
}

if (commandLine.globalOptions.port) {
  process.env.GLIMMERVOID_PORT = commandLine.globalOptions.port;
}

type SubcommandRunner = (subcommandArgs: string[], subcommandName: string) => Promise<number>;

const OWN_SUBCOMMAND_RUNNERS: [string, SubcommandRunner][] = [
  ['doctor', async () => {
    await runDoctor();
    return 0;
  }],
  ['pair', async (subcommandArgs) => {
    const { runPairCli } = await import('../server/pair-cli.ts');
    return runPairCli(subcommandArgs);
  }],
  ['agent', async (subcommandArgs) => {
    const { runAgentSetupCli } = await import('../server/agent-setup-cli.ts');
    return runAgentSetupCli(subcommandArgs);
  }],
  ['settings', async (subcommandArgs) => {
    const { runSettingsCli } = await import('../server/settings-cli.ts');
    return runSettingsCli(subcommandArgs);
  }],
  ['visions', async (subcommandArgs) => {
    const { runVisionsCli } = await import('../server/visions/visions-cli.ts');
    return runVisionsCli(subcommandArgs);
  }],
  ['ssh-sign', async (subcommandArgs) => {
    const { runSshSignCli } = await import('../server/ssh-sign-cli.ts');
    return runSshSignCli(subcommandArgs);
  }],
];

const ownSubcommandNames = new Set(OWN_SUBCOMMAND_RUNNERS.map(([name]) => name));

const SUBCOMMAND_RUNNERS = new Map<string, SubcommandRunner>([
  ...OWN_SUBCOMMAND_RUNNERS,
  ...AGENT_API_VERBS.filter((verb) => !ownSubcommandNames.has(verb)).map((verb): [string, SubcommandRunner] => [verb, async (subcommandArgs, subcommandName) => {
    const { runAgentApiCli } = await import('../server/agent-api-cli.ts');
    return runAgentApiCli([subcommandName, ...subcommandArgs]);
  }]),
]);

const AGENT_INSTALL_COMMAND_BY_ID: Readonly<Record<string, string>> = {
  'claude-code': 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
};

function missingAgentText(agentId: string): string {
  const installCommand = AGENT_INSTALL_COMMAND_BY_ID[agentId];
  if (!installCommand) return 'not found on PATH';
  return `not found on PATH; install with: ${installCommand}`;
}

async function printSessionLimits(): Promise<void> {
  if (!process.env[AGENT_URL_ENV]) return;
  const { sessionLimitsHelpLines } = await import('../server/agent-api-cli.ts');
  const limitsLines = await sessionLimitsHelpLines();
  console.log(`\n${limitsLines.join('\n')}`);
}

function flushStream(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.once('error', () => resolve());
    stream.write('', () => resolve());
  });
}

async function drainOutput(): Promise<void> {
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)]);
}

async function exitAfterOutputDrains(exitCode: number): Promise<never> {
  await drainOutput();
  process.exit(exitCode);
}

async function runSubcommandToExitCode(runSubcommand: SubcommandRunner, subcommandArgs: string[], subcommandName: string): Promise<number> {
  try {
    return await runSubcommand(subcommandArgs, subcommandName);
  } catch (err) {
    console.error(errorText(err));
    return 1;
  }
}

async function dispatchCommandLine(): Promise<void> {
  if (commandLine.kind !== 'subcommand') {
    await import('../server/index.ts');
    return;
  }
  const runSubcommand = SUBCOMMAND_RUNNERS.get(commandLine.name);
  if (!runSubcommand) {
    console.error(`Unknown command: ${commandLine.name}\n${USAGE}`);
    await exitAfterOutputDrains(1);
    return;
  }
  await exitAfterOutputDrains(await runSubcommandToExitCode(runSubcommand, commandLine.subcommandArgs, commandLine.name));
}

await dispatchCommandLine();

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
    return { declared: [], error: `could not read ${decided.path}: ${firstLine(errorText(err))}` };
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
      line(`${id} (${label})`, resolvedPath ?? missingAgentText(id));
    }
    const { inspectGrokAgentSetup } = await import('../server/agent-setup-cli.ts');
    const grokSetup = inspectGrokAgentSetup();
    line('grok hook setup', `${grokSetup.classification}: ${grokSetup.filePath}`);
    const { default: kimi } = await import('../session/adapters/kimi.ts');
    const { describeKimiHome } = await import('../session/kimi-home.ts');
    line('kimi home', describeKimiHome(kimi.expectedHooksBlock()));
  } catch (err) {
    line('agents', `probe failed: ${firstLine(errorText(err))}`);
  }

  switchSection('Sane YOLO');
  try {
    const { resolvePackageBin } = await import('../server/runtime-paths.ts');
    const { execFileSync } = await import('../server/child-process-safe.ts');
    const { inspectGrokAgentSetup } = await import('../server/agent-setup-cli.ts');
    const binPath = resolvePackageBin('cc-safety-net', 'cc-safety-net');
    line('Sane YOLO', binPath || 'not installed');
    if (binPath) line('cc-safety-net version', execFileSync(process.execPath, [binPath, '--version'], { encoding: 'utf8', timeout: 3000 }).trim());
    line('Codex hook trust', 'Sane YOLO is inactive unless Codex trusts the injected hooks.');
    line('Grok Sane YOLO', inspectGrokAgentSetup().saneYoloReady ? 'installed' : 'inactive; run glimmervoid agent setup grok');
  } catch (err) {
    line('Sane YOLO', `probe failed: ${firstLine(errorText(err))}`);
  }

  switchSection('Native module');
  const nodePty = await probeNodePty();
  if (nodePty.ok) line('node-pty', 'loads OK');
  if (!nodePty.ok) {
    line('node-pty', 'FAILED to load');
    line('reason', nodePty.reason);
    line('hint', nodePtyRebuildHint(platform));
  }

  switchSection('Guardrails');
  for (const [label, value] of guardrailsDoctorRows(probeGuardrailsDependencies({ platform, exec: execSync }))) line(label, value);

  switchSection('Git');
  for (const [label, value] of gitDoctorRows(probeGitVersion())) line(label, value);

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
