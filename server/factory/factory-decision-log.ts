import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { isSingleFactoryPathSegment } from '../../shared/contracts/factory.ts';
import type { FactoryDecisionLogLine } from '../../shared/contracts/factory-decision-log.ts';
import { errorMessage, isMissingFileError } from '../../shared/text.ts';
import { glimmervoidHomeDir } from '../config-store.ts';
import { buildFactoryDecisionLine, factoryDecisionDayFileName, factoryWorkerDecision } from './core/factory-decision-log-core.ts';
import type { FactoryDecisionInput, FactoryDecisionWorkerEvent } from './core/factory-decision-log-core.ts';
import { appendJsonLine } from '../json-file.ts';
import { pruneAgedFiles } from '../prune-files.ts';

export function createFactoryDecisionLog({ homeDir = glimmervoidHomeDir(), now = Date.now, log = console, redact = (text) => text, onDecision }: {
  homeDir?: string; now?: () => number; log?: Pick<Console, 'warn'>; redact?: (text: string) => string; onDecision?: (line: FactoryDecisionLogLine) => void;
} = {}) {
  const prunedDayByProject = new Map<string, string>();
  let lastScannedDayFileName: string | null = null;
  const pendingWrites = new Set<Promise<void>>();
  const warn = (error: unknown) => log.warn(`[factory] decision log failed: ${errorMessage(error)}`);

  function decisionsDirectory(projectId: string): string {
    if (!projectId || !isSingleFactoryPathSegment(projectId)) throw new Error('Invalid factory project id');
    return path.join(homeDir, 'factory', projectId, 'decisions');
  }

  async function prune(projectId: string): Promise<void> {
    try {
      const nowMs = now();
      const dayFileName = factoryDecisionDayFileName(new Date(nowMs).toISOString());
      if (prunedDayByProject.get(projectId) === dayFileName) return;
      prunedDayByProject.set(projectId, dayFileName);
      await pruneAgedFiles({ directory: decisionsDirectory(projectId), suffixes: ['.jsonl'], retainDays: 14, now: nowMs });
    } catch (error) {
      warn(error);
    }
  }

  async function pruneEveryProject(): Promise<void> {
    try {
      const dayFileName = factoryDecisionDayFileName(new Date(now()).toISOString());
      if (lastScannedDayFileName === dayFileName) return;
      const projectFolders = await readdir(path.join(homeDir, 'factory'), { withFileTypes: true });
      lastScannedDayFileName = dayFileName;
      await Promise.all(projectFolders.flatMap((projectFolder) => projectFolder.isDirectory() ? [prune(projectFolder.name)] : []));
    } catch (error) {
      if (isMissingFileError(error)) return;
      warn(error);
    }
  }

  async function record(decision: FactoryDecisionInput): Promise<void> {
    try {
      const line = buildFactoryDecisionLine(decision, new Date(now()).toISOString(), redact);
      const filePath = path.join(decisionsDirectory(line.projectId), factoryDecisionDayFileName(line.timestamp));
      onDecision?.(line);
      const writing = appendJsonLine(filePath, line, { mkdir: true, mode: 0o600 }).catch(warn);
      pendingWrites.add(writing);
      void writing.then(() => pendingWrites.delete(writing));
      await prune(line.projectId);
      await writing;
    } catch (error) {
      warn(error);
    }
  }

  function recordEvent(projectId: string, event: FactoryDecisionWorkerEvent): void {
    try {
      const decision = factoryWorkerDecision(projectId, event);
      if (decision) void record(decision);
    } catch (error) {
      warn(error);
    }
  }

  return { record, recordEvent, pruneEveryProject, idle: async () => { await Promise.all([...pendingWrites]); } };
}
