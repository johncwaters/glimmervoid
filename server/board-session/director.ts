import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Session } from '../../session/sessions.ts';
import { DEFAULT_MODELS } from '../../shared/contracts/agent-models.ts';
import { pathsOutsideBranchFolder } from '../../shared/board-branch-core.ts';
import { clock } from '../../shared/clock.ts';
import { errorMessage } from '../../shared/text.ts';
import {
  DIRECTOR_PROMPT_FILE, DIRECTOR_REPLY_MAX_CHARS, DIRECTOR_RESULT_FILE, buildDirectorPrompt, candidatesOf, directorCardOps, directorPayloadOf,
  directorTurnOf, isWorthDirecting, parseDirectorDigest, touchedPathsOf,
} from '../core/director-core.ts';
import type { DirectorTurn } from '../core/director-core.ts';
import { readLaneResultFile } from '../lanes/lane-spawn.ts';
import type { LaneSpawn } from '../lanes/lane-spawn.ts';
import { writeUntrustedPayload } from '../lanes/untrusted-payload.ts';
import type { TracePage, TracePageRequest } from '../trace-wiring.ts';
import type { WhiteboardPort } from '../whiteboard/whiteboard-wiring.ts';

const DIRECTOR_LANE_TOOLS = Object.freeze(['Read', 'Write']);
const DIRECTOR_AUTHOR = Object.freeze({ id: 'director', name: 'Director' });
const BOOTSTRAP_PROMPT = `Read ${DIRECTOR_PROMPT_FILE} and follow its instructions`;
const DIRECTOR_TIMEOUT_MS = 120_000;
const MAX_TRACE_PAGES = 8;
const OUTSIDE_PATHS_NAMED = 5;

type MapLookup = { ok: true; boardId: string | null; boxIdByPath: Record<string, string>; fallbackBoxId: string; boxChoices: { boxId: string; title: string }[] } | { ok: false; error: string };

interface DirectorDeps {
  spawnLane: LaneSpawn;
  drainTrace: (sessionId: string) => Promise<void>;
  readTracePage: (sessionId: string, request: TracePageRequest) => Promise<TracePage>;
  boxesOfSession: (repoDir: string, sessionId: string, paths: readonly string[]) => Promise<MapLookup>;
  boards: Pick<WhiteboardPort, 'boardOf' | 'putWithoutReadCheck'>;
  tellMain: (branchId: string, text: string) => boolean;
  logger?: Pick<Console, 'warn'>;
}

function isStudioSession(session: Session): boolean {
  return !session.ephemeral && (session.isStudioMain || session.branchOf !== null);
}

function createDirector({ spawnLane, drainTrace, readTracePage, boxesOfSession, boards, tellMain, logger = console }: DirectorDeps) {
  const queuedBySessionId = new Map<string, Session>();
  const directedOpenedAtBySessionId = new Map<string, number>();
  const shutdownController = new AbortController();
  let running: Promise<void> | null = null;

  async function readTurn(session: Session): Promise<DirectorTurn | null> {
    await drainTrace(session.id);
    const workingDirectory = session.effectiveCwd();
    let page = await readTracePage(session.id, { after: 0, endingAt: 'tail' });
    let records = page.records;
    for (let pageCount = 1; pageCount <= MAX_TRACE_PAGES; pageCount += 1) {
      const turn = directorTurnOf(records, workingDirectory);
      if (turn !== null || page.start === 0) return turn;
      page = await readTracePage(session.id, { after: 0, endingAt: page.start });
      records = [...page.records, ...records];
    }
    return null;
  }

  async function runLane(turn: DirectorTurn, prompt: (resultPath: string) => string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-director-'));
    const resultPath = path.join(workDir, DIRECTOR_RESULT_FILE);
    try {
      await writeUntrustedPayload(workDir, directorPayloadOf(turn, clock.now().toISOString()), DIRECTOR_REPLY_MAX_CHARS);
      await fs.writeFile(path.join(workDir, DIRECTOR_PROMPT_FILE), prompt(resultPath), 'utf8');
      if (signal.aborted) return null;
      await spawnLane({ id: `director:${crypto.randomUUID()}`, name: 'Studio director', cwd: workDir, prompt: BOOTSTRAP_PROMPT, agent: 'claude-code', model: DEFAULT_MODELS.taskTitleRefiner, signal });
      if (signal.aborted) return null;
      return await readLaneResultFile(resultPath);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  function flagEditsOutsideBranch(session: Session, turn: DirectorTurn): void {
    if (session.branchOf === null) return;
    const outsidePaths = [...pathsOutsideBranchFolder(turn.editedPaths, session.branchOf.aboutTitle), ...turn.editedOutsideWorktreePaths];
    if (outsidePaths.length === 0) return;
    const namedPaths = outsidePaths.slice(0, OUTSIDE_PATHS_NAMED).join(', ');
    const morePaths = outsidePaths.length > OUTSIDE_PATHS_NAMED ? ` and ${outsidePaths.length - OUTSIDE_PATHS_NAMED} more` : '';
    tellMain(session.id, `The branch ${session.name} works on ${session.branchOf.aboutTitle} but its last turn changed ${namedPaths}${morePaths} outside it; check those before its commits come back, or steer it with glimmervoid send ${session.id} <text>.`);
  }

  async function direct(session: Session): Promise<void> {
    const turn = await readTurn(session);
    if (turn === null || directedOpenedAtBySessionId.get(session.id) === turn.openedAt) return;
    directedOpenedAtBySessionId.set(session.id, turn.openedAt);
    flagEditsOutsideBranch(session, turn);
    if (!isWorthDirecting(turn)) return;
    const lookup = await boxesOfSession(session.path, session.id, touchedPathsOf(turn));
    if (!lookup.ok || lookup.boardId === null) return;
    const candidates = candidatesOf(turn, lookup);
    const signal = AbortSignal.any([shutdownController.signal, AbortSignal.timeout(DIRECTOR_TIMEOUT_MS)]);
    const laneOutput = await runLane(turn, (resultPath) => buildDirectorPrompt(candidates, resultPath), signal);
    if (signal.aborted) return;
    const directed = parseDirectorDigest(laneOutput, candidates);
    if (directed === null) {
      logger.warn(`[director] ${session.name}: the lane returned no usable digest`);
      return;
    }
    const board = await boards.boardOf(lookup.boardId);
    if (board === null) return;
    const reply = await boards.putWithoutReadCheck({ ...DIRECTOR_AUTHOR, project: session.path }, lookup.boardId, directorCardOps(session.id, turn, directed, board));
    if (!reply.body.ok) logger.warn(`[director] ${session.name}: the card was refused: ${reply.body.error}`);
  }

  function startNext(): void {
    if (running !== null || shutdownController.signal.aborted) return;
    const [next] = queuedBySessionId.values();
    if (next === undefined) return;
    queuedBySessionId.delete(next.id);
    running = direct(next)
      .catch((error: unknown) => logger.warn(`[director] ${next.name}: ${errorMessage(error)}`))
      .finally(() => {
        running = null;
        startNext();
      });
  }

  function onTurnEnd(session: Session): void {
    if (!isStudioSession(session) || session._destroyed) return;
    queuedBySessionId.set(session.id, session);
    startNext();
  }

  async function stop(): Promise<void> {
    shutdownController.abort();
    queuedBySessionId.clear();
    await running;
  }

  return { onTurnEnd, stop };
}

export { DIRECTOR_LANE_TOOLS, createDirector };
