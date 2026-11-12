import os from 'node:os';
import path from 'node:path';
import { panelActionsJsonSchemaText } from '../../shared/pack-action-core.ts';
import { AGENT_REPLY_SCHEMAS, AGENT_URL_ENV } from '../../shared/contracts/session.ts';
import type { ParsedCommand } from '../core/cli-spec-core.ts';
import { glimmervoidHomeDir } from '../core/config-path-core.ts';
import { examplePacksDir } from '../runtime-paths.ts';
import { packBridgeJsonSchemaText } from '../../shared/contracts/pack-bridge.ts';
import { packJsonSchemaText } from '../../shared/contracts/pack.ts';
import { prFlowsOutputJsonSchemaText } from '../../shared/contracts/pr-flows.ts';
import { packGuideText } from './pack-agent.ts';
import { checkPack, packCheckHasProblem, packReportText } from './pack-check.ts';
import { readApprovedPackFingerprints } from './pack-files.ts';
import { startPackPreviewServer } from './pack-preview-server.ts';

type ParsedRun = Extract<ParsedCommand, { kind: 'run' }>;

async function runPackCheckCli({ packDir, isJson, env, homeDir }: { packDir: string; isJson: boolean; env: NodeJS.ProcessEnv; homeDir: string }): Promise<number> {
  const approvedFingerprints = readApprovedPackFingerprints(homeDir);
  const report = await checkPack(packDir, env, (fingerprint) => approvedFingerprints.has(fingerprint));
  process.stdout.write(`${isJson ? JSON.stringify(report, null, 2) : packReportText(report)}\n`);
  return packCheckHasProblem(report) ? 1 : 0;
}

const SCHEMA_TEXT_BY_NAME: Readonly<Record<string, () => string>> = { pack: packJsonSchemaText, bridge: packBridgeJsonSchemaText, actions: panelActionsJsonSchemaText, 'pr-flows': prFlowsOutputJsonSchemaText };

async function runGuide(homeDir: string, schemaName: string | null): Promise<number> {
  if (schemaName === null) {
    const schemaHint = 'The JSON Schemas, with what each field means: glimmervoid packs guide --schema pack (pack.json), --schema bridge (panel bridge messages), --schema actions (the request of each panel action) and --schema pr-flows (what a prFlows command prints).';
    process.stdout.write(`${await packGuideText({ homeDir, examplePacksDir }, [schemaHint])}\n`);
    return 0;
  }
  const schemaText = SCHEMA_TEXT_BY_NAME[schemaName];
  if (!schemaText) {
    process.stderr.write(`glimmervoid packs guide: --schema is pack, bridge, actions or pr-flows, not ${schemaName}\n`);
    return 1;
  }
  process.stdout.write(schemaText());
  return 0;
}

async function runViaRunningGlimmervoid(subcommand: string, body: Record<string, unknown>): Promise<number> {
  if (!process.env[AGENT_URL_ENV]) {
    process.stderr.write(`glimmervoid packs ${subcommand} works on the running Glimmervoid, so it runs inside a Glimmervoid session; the operator sees the same packs in Settings, Packs\n`);
    return 1;
  }
  const { askAgentApi } = await import('../agent-api-cli.ts');
  const reply = AGENT_REPLY_SCHEMAS.packs.safeParse(await askAgentApi('packs', { command: subcommand, ...body }));
  if (!reply.success) {
    process.stderr.write(`glimmervoid packs ${subcommand}: Glimmervoid did not answer\n`);
    return 1;
  }
  if (!reply.data.ok) {
    process.stderr.write(`glimmervoid packs ${subcommand}: ${reply.data.error}\n`);
    return 1;
  }
  process.stdout.write(`${reply.data.text}\n`);
  return reply.data.hasProblem && subcommand !== 'list' ? 1 : 0;
}

async function runPreview(packDir: string, portText: string | null, env: NodeJS.ProcessEnv, homeDir: string): Promise<number> {
  const port = portText === null ? 0 : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`glimmervoid packs preview: --port must be a port number, not ${portText}\n`);
    return 1;
  }
  const started = await startPackPreviewServer({ packDir, port, env, homeDir });
  if (!started.ok) {
    process.stderr.write(`glimmervoid packs preview: ${started.error}\n`);
    return 1;
  }
  process.stdout.write(`Previewing ${packDir} at ${started.server.url} with sample data; each page load re-reads the pack. Stop with Ctrl-C.\n`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => void started.server.close().then(resolve));
    process.once('SIGTERM', () => void started.server.close().then(resolve));
  });
  return 0;
}

export async function runPacksCli(parsed: ParsedRun): Promise<number> {
  const env = process.env;
  const homeDir = glimmervoidHomeDir(os.homedir(), env);
  const [packArgument] = parsed.positionals;
  const subcommand = parsed.commandPath[1];
  if (subcommand === 'guide') return runGuide(homeDir, typeof parsed.values.schema === 'string' ? parsed.values.schema : null);
  if (subcommand === 'list') return runViaRunningGlimmervoid('list', {});
  if (packArgument === undefined) return 1;
  if (subcommand === 'status' || subcommand === 'request-approval' || subcommand === 'remove') return runViaRunningGlimmervoid(subcommand, { name: packArgument });
  const packDir = path.resolve(packArgument);
  if (subcommand === 'install') return runViaRunningGlimmervoid('install', { path: packDir });
  if (subcommand === 'check') return runPackCheckCli({ packDir, isJson: parsed.values.json === true, env, homeDir });
  return runPreview(packDir, typeof parsed.values.port === 'string' ? parsed.values.port : null, env, homeDir);
}
