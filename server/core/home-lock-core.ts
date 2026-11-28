import { z } from 'zod';

const ALLOW_SHARED_HOME_ENV = 'GLIMMERVOID_ALLOW_SHARED_HOME';
const HANDOFF_FROM_PID_ENV = 'GLIMMERVOID_HANDOFF_FROM_PID';
const HOME_LOCK_FILE_NAME = 'server.lock';
const HOME_LOCK_METADATA_FILE_NAME = 'server.lock.json';
const HOME_LOCK_HANDOFF_WAIT_MS = 5_000;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

const HomeLockHolderSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(0).max(65535).nullable(),
  startedAt: z.string().min(1),
});

type HomeLockHolder = z.infer<typeof HomeLockHolderSchema>;

function isSharedHomeAllowed(env: Record<string, string | undefined>): boolean {
  return env[ALLOW_SHARED_HOME_ENV] === '1';
}

function parseHandoffFromPid(env: Record<string, string | undefined>): number | null {
  const rawPid = env[HANDOFF_FROM_PID_ENV]?.trim() ?? '';
  if (!POSITIVE_INTEGER_PATTERN.test(rawPid)) return null;
  const parsed = Number.parseInt(rawPid, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseHomeLockHolder(rawJson: string): HomeLockHolder | null {
  try {
    const parsed = HomeLockHolderSchema.safeParse(JSON.parse(rawJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function formatHomeLockHolderSummary(holder: HomeLockHolder | null): string {
  if (holder === null) return 'another live Glimmervoid server';
  const portText = holder.port === null ? 'unknown port' : `port ${holder.port}`;
  return `PID ${holder.pid}, ${portText}, started ${holder.startedAt}`;
}

function formatHomeLockRefusal({ homeDir, holder }: { homeDir: string; holder: HomeLockHolder | null }): string {
  return `Refusing to start: Glimmervoid home ${homeDir} is already held by a live server (${formatHomeLockHolderSummary(holder)}). Stop that server, pass a separate GLIMMERVOID_HOME, or set ${ALLOW_SHARED_HOME_ENV}=1 to share the live home on purpose.`;
}

function formatSharedHomeNotice({ homeDir, holder }: { homeDir: string; holder: HomeLockHolder | null }): string {
  return `[glimmervoid] Sharing live home ${homeDir} (${formatHomeLockHolderSummary(holder)}) because ${ALLOW_SHARED_HOME_ENV}=1 is set.`;
}

export {
  ALLOW_SHARED_HOME_ENV,
  HANDOFF_FROM_PID_ENV,
  HOME_LOCK_FILE_NAME,
  HOME_LOCK_HANDOFF_WAIT_MS,
  HOME_LOCK_METADATA_FILE_NAME,
  formatHomeLockRefusal,
  formatSharedHomeNotice,
  isSharedHomeAllowed,
  parseHandoffFromPid,
  parseHomeLockHolder,
};
export type { HomeLockHolder };
