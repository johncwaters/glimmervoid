import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { BUILT_IN_AGENTS } from '../session/adapters/index.ts';
import { clock } from '../shared/clock.ts';
import { spawn } from './child-process-safe.ts';
import { DEFAULT_CONFIG, resolveConfigPath } from './config-store.ts';
import { mergePathEntries, splitPathEntries } from './git/core/dependency-clone-core.ts';
import { createHostUrlOpener } from './host-url-opener.ts';
import { resolveInstallPath } from './install-path.ts';
import { selfLaunch } from './runtime-paths.ts';
import { serverLogPath } from './server-log-file.ts';
import {
  LAUNCH_DIALOG_TITLE,
  LAUNCH_OPENER_HOLD_MS,
  LAUNCH_PROBE_INTERVAL_MS,
  LAUNCH_PROBE_TIMEOUT_MS,
  classifyProbe,
  PROBE_TIMEOUT_FAILURE_CODE,
  dashboardUrlForPort,
  decideLaunchStep,
  dialogCommandsFor,
  launchFailureText,
} from './core/open-launch-core.ts';
import type { LaunchFailure, LaunchPhase, ProbeOutcome, ProbeReply } from './core/open-launch-core.ts';
import { resolveLocalPort } from './core/remote-config.ts';

function configuredPort(): unknown {
  try {
    const config: unknown = JSON.parse(fs.readFileSync(resolveConfigPath(), 'utf8'));
    if (typeof config !== 'object' || config === null) return undefined;
    return (config as { port?: unknown }).port;
  } catch {
    return undefined;
  }
}

function probeFailureCode(error: unknown): string | null {
  if (error instanceof Error && error.name === 'TimeoutError') return PROBE_TIMEOUT_FAILURE_CODE;
  const cause = error instanceof Error ? error.cause : null;
  if (typeof cause !== 'object' || cause === null) return null;
  const causeCode = (cause as { code?: unknown }).code;
  return typeof causeCode === 'string' ? causeCode : null;
}

async function probeDashboard(dashboardUrl: string): Promise<ProbeOutcome> {
  const reply = await fetch(`${dashboardUrl}/control-token`, { signal: AbortSignal.timeout(LAUNCH_PROBE_TIMEOUT_MS) })
    .then(async (response): Promise<ProbeReply> => ({ kind: 'answered', status: response.status, body: await response.json().catch(() => null) }))
    .catch((error: unknown): ProbeReply => ({ kind: 'failed', failureCode: probeFailureCode(error) }));
  return classifyProbe(reply);
}

async function widenedPathText(): Promise<string> {
  const agentCommandNames = BUILT_IN_AGENTS.map(({ adapter }) => adapter.commandName);
  const { extraPathEntries } = await resolveInstallPath(agentCommandNames);
  return mergePathEntries(splitPathEntries(process.env.PATH ?? ''), extraPathEntries).join(path.delimiter);
}

type StartedServer = { hasExited: () => boolean; release: () => void };

async function startDetachedServer(): Promise<StartedServer> {
  const [launcher, ...launchArguments] = selfLaunch('cli');
  const server = spawn(launcher, launchArguments, {
    env: { ...process.env, PATH: await widenedPathText() },
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  let hasExited = false;
  server.once('exit', () => { hasExited = true; });
  server.once('error', () => { hasExited = true; });
  return { hasExited: () => hasExited, release: () => server.unref() };
}

async function runFirstAvailableCommand(commands: string[][]): Promise<void> {
  for (const [command, ...commandArguments] of commands) {
    const hasShown = await new Promise<boolean>((resolve) => {
      const dialog = spawn(command, commandArguments, { stdio: 'ignore', windowsHide: true });
      dialog.once('error', () => resolve(false));
      dialog.once('exit', (exitCode) => resolve(exitCode === 0));
    });
    if (hasShown) return;
  }
}

async function reportFailure(failure: LaunchFailure, port: number): Promise<number> {
  const text = launchFailureText(failure, port, serverLogPath());
  console.error(text);
  await runFirstAvailableCommand(dialogCommandsFor(process.platform, LAUNCH_DIALOG_TITLE, text));
  return 1;
}

async function openDashboard(dashboardUrl: string): Promise<number> {
  const keepProcessAliveTimer = setTimeout(() => {}, LAUNCH_OPENER_HOLD_MS);
  const outcome = await createHostUrlOpener()(dashboardUrl);
  clearTimeout(keepProcessAliveTimer);
  console.log(`Glimmervoid is running at ${dashboardUrl}`);
  return outcome === 'opened' ? 0 : 1;
}

async function runOpenCli(): Promise<number> {
  const port = resolveLocalPort({ envPort: process.env.GLIMMERVOID_PORT, configPort: configuredPort(), defaultPort: DEFAULT_CONFIG.port });
  const dashboardUrl = dashboardUrlForPort(port);
  let phase: LaunchPhase = 'probing';
  let server: StartedServer | null = null;
  let phaseStartedAtMs = clock.nowMs();
  for (;;) {
    const outcome = await probeDashboard(dashboardUrl);
    const step = decideLaunchStep({ phase, outcome, hasChildExited: server?.hasExited() ?? false, elapsedMs: clock.nowMs() - phaseStartedAtMs });
    if (step.kind === 'start-server') {
      server = await startDetachedServer();
      phase = 'starting';
      phaseStartedAtMs = clock.nowMs();
    }
    if (step.kind === 'open-dashboard' || step.kind === 'fail') server?.release();
    if (step.kind === 'open-dashboard') return openDashboard(dashboardUrl);
    if (step.kind === 'fail') return reportFailure(step.failure, port);
    await delay(LAUNCH_PROBE_INTERVAL_MS);
  }
}

export { runOpenCli };
