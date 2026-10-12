import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, link, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { decideConfigPath, glimmervoidHomeDir } from '../../server/core/config-path-core.ts';
import { computeRuntimePaths } from '../../server/core/runtime-paths.ts';
import { TELEMETRY_BATCH_URL, resolveProjectToken } from '../../server/core/telemetry-core.ts';
import type { TelemetryConfig } from '../../server/core/telemetry-core.ts';
import { loadJsonStateFile, writeJsonAtomic } from '../../server/json-file.ts';
import { detectInstallFlavor } from '../../server/update-check.ts';
import { TelemetryFileSettings } from '../../shared/contracts/browser-config.ts';
import { TelemetryState } from '../../shared/contracts/telemetry.ts';
import { errorMessage } from '../../shared/text.ts';
import { HarnessInstallState, buildRunTelemetryBatch, decideHarnessTelemetry, parseHarnessInstallState } from './telemetry-core.ts';
import type { HarnessTelemetryDecision, HarnessTelemetryInputs, RunHomeTelemetrySeed, RunTelemetryContext, TelemetrySendResult } from './telemetry-core.ts';
import type { Verdict } from './verdict.ts';

function harnessInstallStatePath(stateDirectory: string): string {
  return path.join(stateDirectory, 'install-id.json');
}

type StoredInstallState = z.infer<typeof HarnessInstallState>;

async function readStoredInstallState(filePath: string) {
  const loaded = await loadJsonStateFile({ filePath, parse: parseHarnessInstallState, quarantine: false, includeNotDir: false });
  if (loaded.status === 'unreadable' || loaded.status === 'quarantined') throw new Error('Cannot read the harness install identity');
  if (loaded.status === 'loaded') await chmod(filePath, 0o600);
  return loaded;
}

async function hasClaimedInstallState(filePath: string, freshState: StoredInstallState): Promise<boolean> {
  const claimPath = `${filePath}.${randomUUID()}.claim`;
  await writeJsonAtomic(claimPath, freshState, { mkdir: true, mode: 0o600 });
  try {
    await link(claimPath, filePath);
    return true;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    return false;
  } finally { await rm(claimPath, { force: true }); }
}

export async function loadHarnessInstallState(stateDirectory: string): Promise<StoredInstallState> {
  const filePath = harnessInstallStatePath(stateDirectory);
  const stored = await readStoredInstallState(filePath);
  if (stored.status === 'loaded') return stored.value;
  const freshState = HarnessInstallState.parse({ installId: randomUUID() });
  if (stored.status === 'corrupt') {
    await writeJsonAtomic(filePath, freshState, { mkdir: true, mode: 0o600 });
    console.error(`Replaced corrupt harness install identity at ${filePath} with a fresh id`);
    return freshState;
  }
  if (await hasClaimedInstallState(filePath, freshState)) return freshState;
  const storedByAnotherClaim = await readStoredInstallState(filePath);
  if (storedByAnotherClaim.status === 'loaded') return storedByAnotherClaim.value;
  throw new Error('Cannot read the harness install identity');
}

async function readOperatorTelemetryConfig(environment: NodeJS.ProcessEnv, homeDirectory: string): Promise<TelemetryConfig> {
  try {
    const decided = decideConfigPath({ env: environment, homeDir: glimmervoidHomeDir(homeDirectory, environment) }, existsSync);
    if (!decided.path) return {};
    const parsed = z.object({ telemetry: TelemetryFileSettings }).safeParse(JSON.parse(await readFile(decided.path, 'utf8')));
    const isEnabled = parsed.success ? parsed.data.telemetry?.enabled : undefined;
    return typeof isEnabled === 'boolean' ? { telemetry: { enabled: isEnabled } } : {};
  } catch { return {}; }
}

export async function resolveHarnessTelemetryInputs(
  noTelemetry: boolean, stateDirectory: string, environment: NodeJS.ProcessEnv = process.env, homeDirectory = os.homedir(),
): Promise<HarnessTelemetryInputs> {
  const inputsWithoutIdentity: HarnessTelemetryInputs = {
    environment, noTelemetry, operatorConfig: await readOperatorTelemetryConfig(environment, homeDirectory), installId: null, isRemoteDisabled: false,
  };
  if (decideHarnessTelemetry(inputsWithoutIdentity).summary === 'skipped-no-consent') return inputsWithoutIdentity;
  try {
    const installState = await loadHarnessInstallState(stateDirectory);
    return { ...inputsWithoutIdentity, installId: installState.installId, isRemoteDisabled: installState.remoteDisabled === true };
  } catch (error) {
    console.error(`Telemetry is off for this batch: ${errorMessage(error)}`);
    return inputsWithoutIdentity;
  }
}

export async function seedTelemetryState(homeDirectory: string, seed: RunHomeTelemetrySeed): Promise<void> {
  const state = TelemetryState.parse({
    installId: seed.installId, noticeShownAt: new Date().toISOString(), ...(seed.remoteDisabled ? { remoteDisabled: true } : {}),
  });
  await writeJsonAtomic(path.join(homeDirectory, 'telemetry.json'), state, { mode: 0o600 });
}

export async function adoptRunHomeRemoteSwitch(inputs: HarnessTelemetryInputs, runHomeDirectory: string, stateDirectory: string): Promise<HarnessTelemetryInputs> {
  if (inputs.installId === null) return inputs;
  const reported = await loadJsonStateFile({
    filePath: path.join(runHomeDirectory, 'telemetry.json'), quarantine: false,
    parse: (document) => {
      const parsed = TelemetryState.safeParse(document);
      return parsed.success ? parsed.data : null;
    },
  });
  if (reported.status !== 'loaded') return inputs;
  const isRemoteDisabled = reported.value.remoteDisabled === true;
  if (isRemoteDisabled === inputs.isRemoteDisabled) return inputs;
  const filePath = harnessInstallStatePath(stateDirectory);
  try {
    const nextState = HarnessInstallState.parse({ installId: inputs.installId, ...(isRemoteDisabled ? { remoteDisabled: true } : {}) });
    await writeJsonAtomic(filePath, nextState, { mode: 0o600 });
  } catch (error) { console.error(`Cannot persist the telemetry remote switch at ${filePath}: ${errorMessage(error)}`); }
  return { ...inputs, isRemoteDisabled };
}

function hasNamedPackageManifest(directory: string): boolean {
  try {
    return z.object({ name: z.string() }).safeParse(JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))).success;
  } catch { return false; }
}

export async function sendRunTelemetry(options: {
  verdict: Verdict;
  context: RunTelemetryContext;
  decision: HarnessTelemetryDecision;
  builtServerEntryPath: string;
  fetchFn?: typeof fetch;
  batchUrl?: string;
}): Promise<TelemetrySendResult> {
  const { decision } = options;
  if (decision.summary !== 'send') return decision.summary;
  try {
    const packageDocument = z.object({ version: z.string().min(1) }).parse(JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')));
    const builtRuntime = computeRuntimePaths({ moduleFile: options.builtServerEntryPath, hasPackageJson: hasNamedPackageManifest });
    const batch = buildRunTelemetryBatch(options.verdict, options.context, {
      installId: decision.installId, projectToken: resolveProjectToken(decision.childEnvironment), appVersion: packageDocument.version,
      platform: process.platform, nodeVersion: process.versions.node,
      installFlavor: detectInstallFlavor(builtRuntime.packageRoot).flavor, isBundled: builtRuntime.bundled, timestamp: new Date().toISOString(),
    });
    const response = await (options.fetchFn ?? globalThis.fetch)(options.batchUrl ?? TELEMETRY_BATCH_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch), signal: AbortSignal.timeout(5000),
    });
    return response.ok ? 'sent' : 'failed';
  } catch { return 'failed'; }
}
