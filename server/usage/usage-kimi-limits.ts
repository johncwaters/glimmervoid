import nodeFsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { realKimiHome } from '../../session/kimi-home.ts';
import { createLaneLog } from '../lanes/lane-log.ts';
import { errorMessage } from '../../shared/text.ts';
import { kimiUsagesSource, parseKimiUsages, pickKimiAccessToken } from './core/usage-kimi-limits-core.ts';
import type { KimiPlanLimitsSnapshot } from './core/usage-kimi-limits-core.ts';

const KIMI_USAGES_TIMEOUT_MS = 8000;

type KimiPlanLimitsPoll =
  | { kind: 'limits'; snapshot: KimiPlanLimitsSnapshot }
  | { kind: 'unavailable'; reason: string };

interface KimiPlanLimitsReaderOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  fsPromises?: Pick<typeof nodeFsPromises, 'readFile'>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  nowFn?: () => number;
  logger?: Pick<Console, 'warn' | 'log'>;
}

async function readTextOrNull(fsPromises: Pick<typeof nodeFsPromises, 'readFile'>, filePath: string): Promise<string | null> {
  try {
    return await fsPromises.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function createKimiPlanLimitsReader({
  env = process.env,
  homeDir = os.homedir(),
  fsPromises = nodeFsPromises,
  fetchFn = fetch,
  timeoutMs = KIMI_USAGES_TIMEOUT_MS,
  nowFn = Date.now,
  logger = console,
}: KimiPlanLimitsReaderOptions = {}) {
  const laneLog = createLaneLog({ prefix: '[usage]', logger });

  async function pollUsages(): Promise<KimiPlanLimitsPoll> {
    const kimiHome = realKimiHome(env, homeDir);
    const source = kimiUsagesSource(await readTextOrNull(fsPromises, path.join(kimiHome, 'config.toml')), env);
    if (!source) return { kind: 'unavailable', reason: 'no kimi OAuth login in the kimi config' };
    const credentialsText = await readTextOrNull(fsPromises, path.join(kimiHome, 'credentials', `${source.credentialsName}.json`));
    if (credentialsText === null) return { kind: 'unavailable', reason: 'kimi credentials file unreadable' };
    const accessToken = pickKimiAccessToken(credentialsText, nowFn());
    if (accessToken === null) return { kind: 'unavailable', reason: 'kimi access token expired or malformed' };
    try {
      const response = await fetchFn(source.usagesUrl, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return { kind: 'unavailable', reason: `kimi usages answered HTTP ${response.status}` };
      const snapshot = parseKimiUsages(await response.json(), nowFn());
      if (!snapshot) return { kind: 'unavailable', reason: 'kimi usages reported no plan windows' };
      return { kind: 'limits', snapshot };
    } catch (error) {
      return { kind: 'unavailable', reason: `kimi usages request failed: ${errorMessage(error)}` };
    }
  }

  async function readPlanLimits(): Promise<KimiPlanLimitsSnapshot | null> {
    const poll = await pollUsages();
    if (poll.kind === 'limits') return poll.snapshot;
    laneLog.warnOnce(`kimi-plan-limits:${poll.reason}`, 'kimi plan limits unavailable', { reason: poll.reason });
    return null;
  }

  return { readPlanLimits };
}

export { createKimiPlanLimitsReader };
