import { readFile } from 'node:fs/promises';
import type { Config } from '../shared/contracts/config.ts';
import { bootStaggerDelay } from './boot-stagger.ts';
import { createCoderActivityPoller } from './coder-activity-poller.ts';
import type { CoderActivityPoller, CoderActivityPollerDeps, CoderActivityReport } from './coder-activity-poller.ts';
import { coderActivityShouldStart } from './core/coder-activity-core.ts';
import { createLaneRunner } from './lane-runner.ts';

type CoderActivityWiringConfig = Pick<Config, 'coder'>;
interface CoderActivityWiringOptions extends Omit<CoderActivityPollerDeps, 'reportStatus'> {
  config: CoderActivityWiringConfig;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  createPoller?: typeof createCoderActivityPoller;
}

function createCoderActivityReporter({ appSlug, env, fetch: fetchStatus = globalThis.fetch }: {
  appSlug: string;
  env: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
}): (report: CoderActivityReport) => Promise<void> {
  return async (report) => {
    let agentToken = env.CODER_AGENT_TOKEN?.trim();
    if (!agentToken) {
      try {
        agentToken = (await readFile(env.CODER_AGENT_TOKEN_FILE ?? '', 'utf8')).trim();
      } catch {
        throw new Error('Could not read CODER_AGENT_TOKEN_FILE');
      }
    }
    if (!agentToken) throw new Error('Missing CODER_AGENT_TOKEN or empty CODER_AGENT_TOKEN_FILE');
    try {
      const response = await fetchStatus(new URL('/api/v2/workspaceagents/me/app-status', env.CODER_AGENT_URL), {
        method: 'PATCH',
        headers: { 'Coder-Session-Token': agentToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_slug: appSlug, ...report }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return;
      const body: unknown = await response.json().catch(() => null);
      const message = body !== null && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
        ? `: ${body.message.replaceAll(agentToken, '[redacted]')}`
        : '';
      throw new Error(`Coder activity report failed (${response.status})${message}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Coder activity request failed';
      throw new Error(message.replaceAll(agentToken, '[redacted]'));
    }
  };
}

function createCoderActivityWiring({ config, env = process.env, fetch: fetchStatus, createPoller = createCoderActivityPoller, ...pollerDeps }: CoderActivityWiringOptions) {
  const gate = () => coderActivityShouldStart({
    appSlug: config.coder?.appSlug,
    agentUrl: env.CODER_AGENT_URL,
    agentToken: env.CODER_AGENT_TOKEN,
    agentTokenFile: env.CODER_AGENT_TOKEN_FILE,
  });
  const runner = createLaneRunner<CoderActivityPoller>({
    tag: 'coder-activity',
    gate,
    cfgKey: () => JSON.stringify(config.coder ?? null),
    emptyStatus: () => ({}),
    createPoller: () => createPoller({
      ...pollerDeps,
      firstTickDelayMs: pollerDeps.firstTickDelayMs ?? bootStaggerDelay,
      reportStatus: createCoderActivityReporter({ appSlug: config.coder?.appSlug?.trim() ?? '', env, fetch: fetchStatus }),
    }),
  });
  return { start: runner.startPoller, stop: runner.stopPoller, restartIfConfigChanged: runner.restartIfConfigChanged };
}

export { createCoderActivityReporter, createCoderActivityWiring };
export type { CoderActivityWiringConfig, CoderActivityWiringOptions };
