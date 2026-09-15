#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AGENT_API_VERBS } from '../shared/contracts/session.ts';
import type { CustomAgentDeclaration } from '../shared/contracts/config.ts';
import { execSync } from '../server/child-process-safe.ts';
import { decideConfigPath, glimmervoidHomeDir } from '../server/core/config-path-core.ts';
import { nodePtyRebuildHint } from '../server/core/node-pty-preflight-core.ts';
import { probeNodePty } from '../server/node-pty-preflight.ts';
import { packageRoot } from '../server/runtime-paths.ts';
import { formatPathNotice, npmGlobalBinDir, onPath, pnpmGlobalBinDir } from './path-doctor.ts';

const args = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { version: string };

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: glimmervoid [command] [options]

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
  pack build [name] Build one context pack, or every spec
  pack list         List context pack specs and their built versions
  memory forget <id|pattern>  Expunge a remembered record
  memory backfill   Re-run the cold-start transcript backfill
  memory distill [--dry-run]  Rebuild the published projection from the canon
  spawn <prompt>    From inside a Glimmervoid session, start a sibling session on that prompt
  attention <note>  From inside a Glimmervoid session, flag it as needing the operator
  board             From inside a Glimmervoid session, list the live sessions

Options:
  --name <label>    Label for the device being paired (with: pair)
  --port <number>   Override the server port (default: 3000)
  --config <path>   Path to config file (default: ~/.glimmervoid/config.json)
  --version         Show version number
  --help, -h        Show this help message`);
  process.exit(0);
}

if (args.includes('--version')) {
  console.log(pkg.version);
  process.exit(0);
}

if (args[0] === 'doctor' || args.includes('--doctor')) {
  await runDoctor();
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

if (args[0] === 'pair') {
  const { runPairCli } = await import('../server/pair-cli.ts');
  process.exit(runPairCli(args.slice(1)));
}

const isAgentCommand = args[0] === 'agent';
if (isAgentCommand) {
  const { runAgentSetupCli } = await import('../server/agent-setup-cli.ts');
  process.exit(runAgentSetupCli(args.slice(1)));
}

function runAsyncCommand(run: Promise<number | never>): void {
  run.then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(messageOf(err));
      process.exit(1);
    }
  );
}

const isVisionsCommand = args[0] === 'visions';
if (isVisionsCommand) {
  const { runVisionsCli } = await import('../server/visions-cli.ts');
  runAsyncCommand(runVisionsCli(args.slice(1)));
}

const isPackCommand = args[0] === 'pack';
if (isPackCommand) {
  const { runPackCli } = await import('../server/pack-cli.ts');
  runAsyncCommand(runPackCli(args.slice(1)));
}

const isMemoryCommand = args[0] === 'memory';
if (isMemoryCommand) {
  const { runMemoryCli } = await import('../server/memory-cli.ts');
  runAsyncCommand(runMemoryCli(args.slice(1)));
}

const isAgentApiCommand = !!args[0] && (AGENT_API_VERBS as readonly string[]).includes(args[0]);
if (isAgentApiCommand) {
  const { runAgentApiCli } = await import('../server/agent-api-cli.ts');
  runAsyncCommand(runAgentApiCli(args));
}

if (!isPackCommand && !isMemoryCommand && !isAgentCommand && !isVisionsCommand && !isAgentApiCommand) {
  await import('../server/index.ts');
}

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
  const line = (label: string, value: string) => console.log(`  ${label.padEnd(18)} ${value}`);

  console.log('glimmervoid doctor\n');

  console.log('Versions');
  line('glimmervoid', pkg.version);
  line('node', process.version);
  line('platform', `${platform} ${process.arch}`);

  console.log('\nThis CLI');
  line('running from', process.argv[1] || '(unknown)');
  line('package dir', packageRoot);

  console.log('\nPATH registration');

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

  console.log('\nAgents');

  try {
    const { listAgentIds, getAdapter, describeAgentResolvability, setCustomAgents } = await import('../session/adapters/index.ts');
    const declaredCustomAgents = await readDeclaredCustomAgents();
    if (declaredCustomAgents.error) line('config', declaredCustomAgents.error);
    setCustomAgents(declaredCustomAgents.declared);
    for (const id of listAgentIds()) {
      const adapter = getAdapter(id);
      if (!adapter) continue;
      const { label, path: resolvedPath } = describeAgentResolvability(id);
      line(`${id} (${label})`, resolvedPath ?? 'not found on PATH');
      line(`${id} pack carrier`, adapter.capabilities.packs ? adapter.packCarrier : 'unsupported');
      const packNoticeCaveat = 'packNoticeCaveat' in adapter ? adapter.packNoticeCaveat : '';
      if (packNoticeCaveat) line(`${id} pack notices`, packNoticeCaveat);
    }
    const { inspectGrokAgentSetup } = await import('../server/agent-setup-cli.ts');
    const grokSetup = inspectGrokAgentSetup();
    line('grok hook setup', `${grokSetup.classification}: ${grokSetup.filePath}`);
  } catch (err) {
    line('agents', `probe failed: ${firstLineOf(err)}`);
  }

  console.log('\nrtk');
  try {
    const { getRtkPath } = await import('../server/rtk-resolver.ts');
    const rtkPath = getRtkPath();
    line('rtk', rtkPath || 'not installed (Glimmervoid installs it when the rtk setting is on)');
  } catch (err) {
    line('rtk', `probe failed: ${firstLineOf(err)}`);
  }

  console.log('\nNative module');
  const nodePty = await probeNodePty();
  if (nodePty.ok) line('node-pty', 'loads OK');
  if (!nodePty.ok) {
    line('node-pty', 'FAILED to load');
    line('reason', nodePty.reason);
    line('hint', nodePtyRebuildHint(platform));
  }

  console.log('\nConfig');
  line('resolved config', resolveConfigPathReadOnly());

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
