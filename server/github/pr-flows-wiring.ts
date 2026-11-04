import type { MyPr } from '../../shared/contracts/my-prs.ts';
import { PrFlowsState } from '../../shared/contracts/pr-flows.ts';
import type { PrFlowDisposeRequest, PrFlowDisposeResult, PrFlowItem, PrFlowsStatus } from '../../shared/contracts/pr-flows.ts';
import { createJsonStateStore } from '../json-file.ts';
import { fencedUntrusted } from '../lanes/core/lane-report-core.ts';
import { fixLocallyPrompt, itemLocation, withHandled, withOnlyOpenPrs } from './core/pr-flows-core.ts';

const UNTRUSTED_COMMENT_MAX_CHARS = 4000;

interface PasteTarget {
  pasteTextWhenReady(text: string, options: { submit: boolean }): { ok: boolean; reason?: string; deferred?: boolean };
  hasPendingPaste(): boolean;
}

interface PrFlowsWiringOptions {
  statePath: string | null;
  openPrs: () => readonly MyPr[];
  github: { replyToReviewThread(threadId: string, body: string): Promise<{ ok: boolean; err: string }>; resolveReviewThread(threadId: string): Promise<{ ok: boolean; err: string }> };
  broadcast: (frame: PrFlowsStatus) => void;
  log: Pick<Console, 'warn'>;
  now?: () => number;
}

function createPrFlowsWiring({ statePath, openPrs, github, broadcast, log, now = Date.now }: PrFlowsWiringOptions) {
  let state: PrFlowsState = { handledByPr: {} };
  const store = createJsonStateStore({
    name: 'pr flows', filePath: statePath,
    parse: (raw) => PrFlowsState.safeParse(raw).data ?? null,
    adopt: (loadedState) => { state = loadedState ?? state; },
    warn: (message, fields) => log.warn(`[pr-flows] ${message} ${JSON.stringify(fields)}`),
  });
  const loaded = store.load();
  const repliedThreadIds = new Set<string>();
  const resolvedThreadIds = new Set<string>();

  function statusFrame(): PrFlowsStatus {
    return { type: 'pr-flows-status', handledByPr: state.handledByPr };
  }

  function findItem(request: PrFlowDisposeRequest): { pr: MyPr; item: PrFlowItem } | null {
    const pr = openPrs().find((candidate) => candidate.key === request.prKey);
    const item = pr?.reviewItems.find((candidate) => candidate.key === request.itemKey);
    return pr && item ? { pr, item } : null;
  }

  async function recordHandled(request: PrFlowDisposeRequest, item: PrFlowItem): Promise<void> {
    await loaded;
    const openPrKeys = new Set(openPrs().map((pr) => pr.key));
    const handled = { itemKey: item.key, dismissalKeys: item.sources.map((source) => source.dismissalKey), action: request.action, location: itemLocation(item), reason: request.reason ?? null, at: now() };
    state = withOnlyOpenPrs(withHandled(state, request.prKey, handled), openPrKeys);
    const persistedState = state;
    await store.write(persistedState, () => `${JSON.stringify(persistedState, null, 2)}\n`);
    broadcast(statusFrame());
  }

  async function dismissThreads(item: PrFlowItem, reason: string): Promise<string | null> {
    for (const source of item.sources) {
      const threadId = source.threadId;
      if (threadId === undefined || resolvedThreadIds.has(threadId)) continue;
      if (!repliedThreadIds.has(threadId)) {
        const replied = await github.replyToReviewThread(threadId, reason);
        if (!replied.ok) return `Could not reply on GitHub: ${replied.err}`;
        repliedThreadIds.add(threadId);
      }
      const resolved = await github.resolveReviewThread(threadId);
      if (!resolved.ok) return `Replied, but could not resolve the thread: ${resolved.err}`;
      resolvedThreadIds.add(threadId);
    }
    return null;
  }

  async function dispose(request: PrFlowDisposeRequest, linkedSession: PasteTarget | null): Promise<PrFlowDisposeResult> {
    const found = findItem(request);
    if (!found) return { ok: false, error: 'That review item is no longer open on this pull request.' };
    if (request.action === 'fix-local') {
      if (!linkedSession) return { ok: false, error: 'No live session is linked to this pull request.' };
      if (linkedSession.hasPendingPaste()) return { ok: false, error: 'The linked session already has a prompt waiting to be pasted, so nothing was sent.' };
      const fence = (label: string, text: string) => fencedUntrusted(label, text, UNTRUSTED_COMMENT_MAX_CHARS);
      const pasted = linkedSession.pasteTextWhenReady(fixLocallyPrompt(found.pr.url, found.item, fence), { submit: true });
      if (!pasted.ok) return { ok: false, error: `Could not write to the linked session (${pasted.reason ?? 'unknown reason'}).` };
      if (pasted.deferred === true) return { ok: true, isPending: true };
      await recordHandled(request, found.item);
      return { ok: true };
    }
    const failure = await dismissThreads(found.item, request.reason ?? '');
    if (failure) return { ok: false, error: failure };
    await recordHandled(request, found.item);
    return { ok: true };
  }

  return { statusFrame, dispose };
}

type PrFlowsWiring = ReturnType<typeof createPrFlowsWiring>;

export { createPrFlowsWiring };
export type { PrFlowsWiring };
