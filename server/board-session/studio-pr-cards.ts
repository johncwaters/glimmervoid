import { comparablePrKey } from '../../shared/contracts/github-prs.ts';
import type { GithubPr } from '../../shared/contracts/github-prs.ts';
import type { LinkedPr } from '../../shared/contracts/my-prs.ts';
import { errorMessage } from '../../shared/text.ts';
import { PR_CARD_HEIGHT, prCardBoxId, prCardFieldsOf } from '../core/studio-pr-card-core.ts';
import type { WhiteboardPort } from '../whiteboard/whiteboard-wiring.ts';
import type { Box } from '../../shared/contracts/whiteboard.ts';

interface PrCardSession {
  id: string;
  readonly linkedPrs: readonly LinkedPr[];
}

interface TrackedCard {
  boardId: string;
  ownerSessionId: string;
  anchorBoxId: string | null;
  phase: 'awaiting-status' | 'placed' | 'dismissed';
}

interface StudioPrCardsDeps {
  store: {
    getSnapshot(): { prs: Readonly<Record<string, GithubPr>> };
    subscribe(event: 'snapshot-changed', listener: () => void): () => void;
  };
  studioSessions: () => readonly PrCardSession[];
  studioBoardIdOf: (sessionId: string) => Promise<string | null>;
  anchorBoxIdOf: (sessionId: string) => string | null;
  boards: Pick<WhiteboardPort, 'putPrCard' | 'boardOf'>;
  logger?: Pick<Console, 'warn'>;
}

function cardFieldsJsonOf(box: Box): string {
  const { title, icon, tone, pullRequest } = box;
  const lines = box.lines.map(({ key, text, style, muted }) => ({ key, text, style, muted }));
  return JSON.stringify({ title, icon, lines, tone, pullRequest });
}

function createStudioPrCards({ store, studioSessions, studioBoardIdOf, anchorBoxIdOf, boards, logger = console }: StudioPrCardsDeps) {
  const trackedByKey = new Map<string, TrackedCard>();
  const resolvingKeys = new Set<string>();
  let writing: Promise<void> = Promise.resolve();
  let isSyncQueued = false;

  async function trackLinkedPrs(prsByKey: Readonly<Record<string, GithubPr>>): Promise<void> {
    for (const session of studioSessions()) {
      for (const link of session.linkedPrs) {
        const key = comparablePrKey(link);
        if (trackedByKey.has(key) || resolvingKeys.has(key) || !prsByKey[key]) continue;
        resolvingKeys.add(key);
        const boardId = await studioBoardIdOf(session.id).catch((error: unknown) => {
          logger.warn(`[studio-pr-cards] the Studio map of session ${session.id} could not be found: ${errorMessage(error)}`);
          return null;
        });
        resolvingKeys.delete(key);
        if (boardId !== null) trackedByKey.set(key, { boardId, ownerSessionId: session.id, anchorBoxId: anchorBoxIdOf(session.id), phase: 'awaiting-status' });
      }
    }
  }

  async function writeCard(key: string, tracked: TrackedCard, pr: GithubPr): Promise<void> {
    const fields = prCardFieldsOf(pr);
    const boxId = prCardBoxId(pr);
    const board = await boards.boardOf(tracked.boardId);
    if (board === null) {
      trackedByKey.delete(key);
      return;
    }
    const placedBox = board.elements.get(boxId);
    if (tracked.phase === 'placed' && placedBox === undefined) {
      tracked.phase = 'dismissed';
      return;
    }
    if (placedBox?.kind === 'box' && cardFieldsJsonOf(placedBox) === JSON.stringify(fields)) {
      tracked.phase = 'placed';
      return;
    }
    const reply = await boards.putPrCard(tracked.boardId, { boxId, fields, height: PR_CARD_HEIGHT, anchorBoxId: tracked.anchorBoxId, ownerSessionId: tracked.ownerSessionId });
    if (!reply.body.ok) {
      logger.warn(`[studio-pr-cards] the card for ${key} could not be written: ${reply.body.error}`);
      trackedByKey.delete(key);
      return;
    }
    tracked.phase = 'placed';
  }

  async function syncCards(): Promise<void> {
    const { prs } = store.getSnapshot();
    await trackLinkedPrs(prs);
    for (const [key, tracked] of trackedByKey) {
      const pr = prs[key];
      if (pr && tracked.phase !== 'dismissed') await writeCard(key, tracked, pr);
    }
  }

  function runQueuedSync(): Promise<void> {
    isSyncQueued = false;
    return syncCards();
  }

  function onSnapshotChanged(): void {
    if (isSyncQueued) return;
    isSyncQueued = true;
    writing = writing.then(runQueuedSync).catch((error: unknown) => logger.warn(`[studio-pr-cards] pull request cards could not be synced: ${errorMessage(error)}`));
  }

  const unsubscribe = store.subscribe('snapshot-changed', onSnapshotChanged);
  return { stop: unsubscribe, settled: () => writing, syncSoon: onSnapshotChanged };
}

export { createStudioPrCards };
