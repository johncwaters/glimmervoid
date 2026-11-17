import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeUntrustedPayload } from '../lanes/untrusted-payload.ts';
import type { ControlMessageRecord } from '../core/control-replay-core.ts';
import type { SessionReviewResult } from '../../shared/contracts/session-review.ts';
import { clock } from '../../shared/clock.ts';
import { errorMessage } from '../../shared/text.ts';
import {
  SESSION_REVIEW_BOOTSTRAP_PROMPT, SESSION_REVIEW_DIFF_MAX_CHARS, SESSION_REVIEW_PROMPT_FILENAME, SESSION_REVIEW_REPORT_FILENAME,
  SESSION_REVIEW_REPORT_MAX_BYTES, SESSION_REVIEW_TIMEOUT_MS, SESSION_REVIEW_UNTRUSTED_SOURCE,
  boundedToSeenDiff, buildSessionReviewPrompt, parseSessionReviewReport, readSessionReviewer,
} from './core/session-review-core.ts';
import type { SessionReviewer } from './core/session-review-core.ts';

interface ReviewerSpawnRequest {
  id: string;
  name: string;
  cwd: string;
  prompt: string;
  reviewer: SessionReviewer;
  readPaths: string[];
  signal: AbortSignal;
}

interface ReviewableSession {
  id: string;
  name: string;
  hasOwnWorktree: boolean;
  worktreeDir: string | null;
  getDiff(): Promise<{ patch: string }>;
  worktreeLifecycle: { computeWorktreeSignature(): Promise<{ sig: string } | null> };
}

interface SessionReviewDependencies {
  spawnReviewer: (request: ReviewerSpawnRequest) => Promise<void>;
  getSessionReviewConfig: () => unknown;
  broadcastControl: (message: ControlMessageRecord) => void;
  logger: Pick<Console, 'warn'>;
}

interface SessionReviewWiring {
  latest(sessionId: string): SessionReviewResult | null;
  run(session: ReviewableSession): Promise<SessionReviewResult>;
  forgetSession(sessionId: string): void;
}

async function readReport(reportPath: string): Promise<string | null> {
  const stat = await fs.lstat(reportPath).catch(() => null);
  if (!stat?.isFile() || stat.size > SESSION_REVIEW_REPORT_MAX_BYTES) return null;
  return fs.readFile(reportPath, 'utf8').catch(() => null);
}

function createSessionReviewWiring(dependencies: SessionReviewDependencies): SessionReviewWiring {
  const latestBySession = new Map<string, SessionReviewResult>();
  const inFlightBySession = new Map<string, Promise<SessionReviewResult>>();
  const stopBySession = new Map<string, AbortController>();

  function publish(result: SessionReviewResult, stopped: AbortSignal): SessionReviewResult {
    if (stopped.aborted) return result;
    latestBySession.set(result.sessionId, result);
    dependencies.broadcastControl({ type: 'session-review', id: result.sessionId, result });
    return result;
  }

  function finished(started: SessionReviewResult, outcome: Pick<SessionReviewResult, 'status' | 'verdict' | 'summary' | 'findings' | 'error'>): SessionReviewResult {
    return { ...started, ...outcome, finishedAt: clock.nowMs() };
  }

  async function review(session: ReviewableSession, started: SessionReviewResult, worktreeDir: string, patch: string, stopped: AbortSignal): Promise<SessionReviewResult> {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-session-review-'));
    try {
      const reportPath = path.join(workDir, SESSION_REVIEW_REPORT_FILENAME);
      await writeUntrustedPayload(workDir, {
        trust: 'untrusted', source: SESSION_REVIEW_UNTRUSTED_SOURCE, fetchedAt: clock.now().toISOString(),
        items: [{ kind: 'diff', ref: session.id, text: patch }],
      }, SESSION_REVIEW_DIFF_MAX_CHARS);
      await fs.writeFile(path.join(workDir, SESSION_REVIEW_PROMPT_FILENAME), buildSessionReviewPrompt({ worktreeDir, reportPath, reviewer: started.reviewer, diffChars: patch.length }), 'utf8');
      const signal = AbortSignal.any([AbortSignal.timeout(SESSION_REVIEW_TIMEOUT_MS), stopped]);
      await dependencies.spawnReviewer({
        id: `session-review:${session.id}:${randomUUID().slice(0, 8)}`,
        name: `Review ${session.name}`.slice(0, 64),
        cwd: workDir, prompt: SESSION_REVIEW_BOOTSTRAP_PROMPT, reviewer: started.reviewer, readPaths: [worktreeDir], signal,
      });
      const outcome = parseSessionReviewReport(await readReport(reportPath));
      if (!outcome.ok) return finished(started, { status: 'failed', verdict: null, summary: '', findings: [], error: signal.aborted ? 'the reviewer ran out of time' : outcome.reason });
      const { verdict, summary } = boundedToSeenDiff(outcome, patch.length);
      return finished(started, { status: 'done', verdict, summary, findings: outcome.findings, error: null });
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  async function startReview(session: ReviewableSession, stopped: AbortSignal): Promise<SessionReviewResult> {
    const reviewer = readSessionReviewer(dependencies.getSessionReviewConfig());
    const base: SessionReviewResult = {
      sessionId: session.id, sig: '', reviewer, status: 'failed', verdict: null, summary: '', findings: [], error: null, startedAt: clock.nowMs(), finishedAt: clock.nowMs(),
    };
    const worktreeDir = session.worktreeDir;
    if (!session.hasOwnWorktree || worktreeDir === null) return publish({ ...base, error: 'This session has no worktree of its own to review.' }, stopped);
    const tree = await session.worktreeLifecycle.computeWorktreeSignature();
    if (!tree) return publish({ ...base, error: 'The worktree could not be read.' }, stopped);
    const cached = latestBySession.get(session.id);
    if (cached && cached.sig === tree.sig && cached.status === 'done' && cached.reviewer.agent === reviewer.agent && cached.reviewer.model === reviewer.model) return publish(cached, stopped);
    const { patch } = await session.getDiff();
    if (patch.trim().length === 0) return publish({ ...base, sig: tree.sig, error: 'This session has no changes to review.' }, stopped);
    const started = publish({ ...base, sig: tree.sig, status: 'running', finishedAt: null }, stopped);
    const result = await review(session, started, worktreeDir, patch, stopped).catch((error: unknown) => {
      dependencies.logger.warn(`[session-review] ${session.id}: ${errorMessage(error)}`);
      return finished(started, { status: 'failed', verdict: null, summary: '', findings: [], error: `The reviewer failed: ${errorMessage(error)}` });
    });
    return publish(result, stopped);
  }

  function failedBeforeStart(session: ReviewableSession, error: unknown, stopped: AbortSignal): SessionReviewResult {
    dependencies.logger.warn(`[session-review] ${session.id}: ${errorMessage(error)}`);
    const now = clock.nowMs();
    const failed: SessionReviewResult = {
      sessionId: session.id, sig: '', reviewer: readSessionReviewer(dependencies.getSessionReviewConfig()), status: 'failed', verdict: null, summary: '', findings: [],
      error: `The review could not start: ${errorMessage(error)}`, startedAt: now, finishedAt: now,
    };
    return publish(failed, stopped);
  }

  function run(session: ReviewableSession): Promise<SessionReviewResult> {
    const inFlight = inFlightBySession.get(session.id);
    if (inFlight) return inFlight;
    const stop = new AbortController();
    stopBySession.set(session.id, stop);
    const pending = startReview(session, stop.signal)
      .catch((error: unknown) => failedBeforeStart(session, error, stop.signal))
      .finally(() => {
        inFlightBySession.delete(session.id);
        if (stopBySession.get(session.id) === stop) stopBySession.delete(session.id);
      });
    inFlightBySession.set(session.id, pending);
    return pending;
  }

  function forgetSession(sessionId: string): void {
    stopBySession.get(sessionId)?.abort();
    stopBySession.delete(sessionId);
    latestBySession.delete(sessionId);
  }

  return {
    latest: (sessionId) => latestBySession.get(sessionId) ?? null,
    run,
    forgetSession,
  };
}

export { createSessionReviewWiring };
export type { SessionReviewWiring };
