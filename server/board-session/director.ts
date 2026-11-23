import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Session } from '../../session/sessions.ts';
import { DEFAULT_MODELS } from '../../shared/contracts/agent-models.ts';
import { DirectorDigestState } from '../../shared/contracts/director-digests.ts';
import type { DirectorDigest } from '../../shared/contracts/director-digests.ts';
import { clock } from '../../shared/clock.ts';
import { errorMessage } from '../../shared/text.ts';
import {
  DIRECTOR_PROMPT_FILE, DIRECTOR_REPLY_MAX_CHARS, DIRECTOR_RESULT_FILE, buildDirectorPrompt, directorPayloadOf, directorTurnOf,
  directorVerdictsOf, hasReply, leftoverDirectorCardOps, parseDirectorVerdict, withDirectorDigest,
} from '../core/director-core.ts';
import type { DirectorTurn } from '../core/director-core.ts';
import { createJsonStateStore } from '../json-file.ts';
import { readLaneResultFile } from '../lanes/lane-spawn.ts';
import type { LaneSpawn } from '../lanes/lane-spawn.ts';
import { writeUntrustedPayload } from '../lanes/untrusted-payload.ts';
import type { TracePage, TracePageRequest } from '../trace-wiring.ts';
import type { WhiteboardPort } from '../whiteboard/whiteboard-wiring.ts';

const DIRECTOR_LANE_TOOLS = Object.freeze(['Read', 'Write']);
const DIRECTOR_AUTHOR = Object.freeze({ id: 'director', name: 'Director' });
const BOOTSTRAP_PROMPT = `Read ${DIRECTOR_PROMPT_FILE} and follow its instructions`;
const DIRECTOR_TIMEOUT_MS = 120_000;
const DIRECTOR_SETTLE_MS = 5_000;
const SETTLE_REARMS_MAX = 6;
const MAX_TRACE_PAGES = 8;

interface DirectorDeps {
  spawnLane: LaneSpawn;
  drainTrace: (sessionId: string) => Promise<void>;
  readTracePage: (sessionId: string, request: TracePageRequest) => Promise<TracePage>;
  digestsPath: string | null;
  announceDigest: (sessionId: string) => void;
  boards: Pick<WhiteboardPort, 'loaded' | 'boardOf' | 'putWithoutReadCheck' | 'snapshotMessage'>;
  settleMs?: number;
  logger?: Pick<Console, 'warn'>;
}

type DirectedSession = Pick<Session, 'id' | 'name' | 'ephemeral' | 'isStudioMain' | 'branchOf' | '_destroyed'>;

interface QueuedTurn {
  session: DirectedSession;
  endedAtMs: number;
}

function isStudioSession(session: DirectedSession): boolean {
  return !session.ephemeral && (session.isStudioMain || session.branchOf !== null);
}

function createDirector({ spawnLane, drainTrace, readTracePage, digestsPath, announceDigest, boards, settleMs = DIRECTOR_SETTLE_MS, logger = console }: DirectorDeps) {
  const queuedBySessionId = new Map<string, QueuedTurn>();
  const settlingBySessionId = new Map<string, { session: DirectedSession; endedAtMs: number; settleDeadlineMs: number; timer: ReturnType<typeof setTimeout> }>();
  const directedOpenedAtBySessionId = new Map<string, number>();
  const shutdownController = new AbortController();
  let digestState: DirectorDigestState = DirectorDigestState.parse({});
  let running: Promise<void> | null = null;
  const unsavedVerdicts: { sessionId: string; digest: DirectorDigest }[] = [];
  const store = createJsonStateStore({
    name: 'director digests', filePath: digestsPath,
    parse: (raw) => DirectorDigestState.safeParse(raw).data ?? null,
    adopt: (loadedState) => {
      digestState = unsavedVerdicts.reduce((state, unsaved) => withDirectorDigest(state, unsaved.sessionId, unsaved.digest), loadedState ?? DirectorDigestState.parse({}));
    },
    warn: (message, fields) => logger.warn(`[director] ${message} ${JSON.stringify(fields)}`),
  });
  void store.load();

  async function readTurn(session: DirectedSession, endedAtMs: number): Promise<DirectorTurn | null> {
    await drainTrace(session.id);
    let page = await readTracePage(session.id, { after: 0, endingAt: 'tail' });
    let records = page.records;
    for (let pageCount = 1; pageCount <= MAX_TRACE_PAGES; pageCount += 1) {
      const turn = directorTurnOf(records, endedAtMs);
      if (turn !== null || page.start === 0) return turn;
      page = await readTracePage(session.id, { after: 0, endingAt: page.start });
      records = [...page.records, ...records];
    }
    return null;
  }

  async function runLane(turn: DirectorTurn, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-director-'));
    const resultPath = path.join(workDir, DIRECTOR_RESULT_FILE);
    try {
      await writeUntrustedPayload(workDir, directorPayloadOf(turn, clock.now().toISOString()), DIRECTOR_REPLY_MAX_CHARS);
      await fs.writeFile(path.join(workDir, DIRECTOR_PROMPT_FILE), buildDirectorPrompt(resultPath), 'utf8');
      if (signal.aborted) return null;
      await spawnLane({ id: `director:${crypto.randomUUID()}`, name: 'Studio director', cwd: workDir, prompt: BOOTSTRAP_PROMPT, agent: 'claude-code', model: DEFAULT_MODELS.taskTitleRefiner, signal });
      if (signal.aborted) return null;
      return await readLaneResultFile(resultPath);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  async function saveDigestState(): Promise<void> {
    const keptState = digestState;
    const isSaved = await store.write(keptState, () => `${JSON.stringify(keptState, null, 2)}\n`);
    if (isSaved) unsavedVerdicts.length = 0;
  }

  async function loadWithUnsavedVerdicts(): Promise<void> {
    await store.load();
    if (unsavedVerdicts.length > 0) await saveDigestState();
  }

  async function keepVerdict(sessionId: string, openedAt: number, verdict: { chatLine: string | null; digest: string | null; points: string[] }): Promise<void> {
    await store.load();
    const digest: DirectorDigest = { openedAt, ...verdict };
    digestState = withDirectorDigest(digestState, sessionId, digest);
    unsavedVerdicts.push({ sessionId, digest });
    await saveDigestState();
    announceDigest(sessionId);
  }

  async function direct({ session, endedAtMs }: QueuedTurn): Promise<void> {
    const turn = await readTurn(session, endedAtMs);
    if (turn === null || !hasReply(turn) || directedOpenedAtBySessionId.get(session.id) === turn.openedAt) return;
    directedOpenedAtBySessionId.set(session.id, turn.openedAt);
    const signal = AbortSignal.any([shutdownController.signal, AbortSignal.timeout(DIRECTOR_TIMEOUT_MS)]);
    const laneOutput = await runLane(turn, signal);
    if (signal.aborted) return;
    const verdict = parseDirectorVerdict(laneOutput);
    if (verdict === null) {
      logger.warn(`[director] ${session.name}: the lane returned no usable verdict`);
      return;
    }
    if (verdict.chatLine === null && verdict.digest === null) return;
    await keepVerdict(session.id, turn.openedAt, verdict);
  }

  function startNext(): void {
    if (running !== null || shutdownController.signal.aborted) return;
    const [next] = queuedBySessionId.values();
    if (next === undefined) return;
    queuedBySessionId.delete(next.session.id);
    running = direct(next)
      .catch((error: unknown) => logger.warn(`[director] ${next.session.name}: ${errorMessage(error)}`))
      .finally(() => {
        running = null;
        startNext();
      });
  }

  function queueSettled(sessionId: string): void {
    const settling = settlingBySessionId.get(sessionId);
    if (settling === undefined) return;
    clearTimeout(settling.timer);
    settlingBySessionId.delete(sessionId);
    if (settling.session._destroyed) return;
    queuedBySessionId.set(sessionId, { session: settling.session, endedAtMs: settling.endedAtMs });
    startNext();
  }

  function armSettle(session: DirectedSession, endedAtMs: number, settleDeadlineMs: number): void {
    clearTimeout(settlingBySessionId.get(session.id)?.timer);
    const waitMs = Math.max(0, Math.min(settleMs, settleDeadlineMs - clock.nowMs()));
    const timer = setTimeout(() => queueSettled(session.id), waitMs);
    timer.unref?.();
    settlingBySessionId.set(session.id, { session, endedAtMs, settleDeadlineMs, timer });
  }

  function onTurnEnd(session: DirectedSession): void {
    if (shutdownController.signal.aborted || !isStudioSession(session) || session._destroyed) return;
    const endedAtMs = clock.nowMs();
    armSettle(session, endedAtMs, endedAtMs + settleMs * SETTLE_REARMS_MAX);
  }

  function onTraceAppended({ id, opensOperatorTurn }: { id: string; opensOperatorTurn: boolean }): void {
    const settling = settlingBySessionId.get(id);
    if (settling === undefined) return;
    if (opensOperatorTurn) {
      queueSettled(id);
      return;
    }
    armSettle(settling.session, settling.endedAtMs, settling.settleDeadlineMs);
  }

  async function verdictsOf(sessionIds: readonly string[]) {
    await loadWithUnsavedVerdicts();
    return directorVerdictsOf(digestState, sessionIds);
  }

  async function removeLeftoverCards(): Promise<void> {
    await store.load();
    if (digestState.hasSweptLeftoverCards) return;
    await boards.loaded;
    for (const summary of boards.snapshotMessage().boards) {
      if (summary.project === null) continue;
      const board = await boards.boardOf(summary.id);
      const ops = board === null ? [] : leftoverDirectorCardOps(board);
      if (ops.length === 0) continue;
      const reply = await boards.putWithoutReadCheck({ ...DIRECTOR_AUTHOR, project: summary.project }, summary.id, ops);
      if (!reply.body.ok) {
        logger.warn(`[director] leftover cards on ${summary.title} stayed: ${reply.body.error}`);
        return;
      }
    }
    digestState = { ...digestState, hasSweptLeftoverCards: true };
    const sweptState = digestState;
    await store.write(sweptState, () => `${JSON.stringify(sweptState, null, 2)}\n`);
  }

  void removeLeftoverCards().catch((error: unknown) => logger.warn(`[director] leftover cards stayed: ${errorMessage(error)}`));

  async function stop(): Promise<void> {
    shutdownController.abort();
    for (const settling of settlingBySessionId.values()) clearTimeout(settling.timer);
    settlingBySessionId.clear();
    queuedBySessionId.clear();
    await running;
    await store.idle();
  }

  return { onTurnEnd, onTraceAppended, verdictsOf, stop };
}

type Director = ReturnType<typeof createDirector>;

export { DIRECTOR_LANE_TOOLS, createDirector };
export type { Director };
