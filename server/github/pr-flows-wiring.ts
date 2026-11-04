import type { MyPr } from '../../shared/contracts/my-prs.ts';
import { PrFlowRule, PrFlowsState } from '../../shared/contracts/pr-flows.ts';
import type { PrFlowDisposeRequest, PrFlowDisposeResult, PrFlowItem, PrFlowItemRequest, PrFlowSaveRuleRequest, PrFlowsStatus } from '../../shared/contracts/pr-flows.ts';
import { createJsonStateStore } from '../json-file.ts';
import { fencedUntrusted } from '../lanes/core/lane-report-core.ts';
import { fixLocallyPrompt, itemLocation, plannedActions, prFlowRules, savedRuleFor, unknownActionWarnings, withHandled, withOnlyOpenPrs, withReopened } from './core/pr-flows-core.ts';

const UNTRUSTED_COMMENT_MAX_CHARS = 4000;

interface PasteTarget {
  pasteTextWhenReady(text: string, options: { submit: boolean }): { ok: boolean; reason?: string; deferred?: boolean };
  hasPendingPaste(): boolean;
}

type GithubWrite = Promise<{ ok: boolean; err: string }>;

interface PrFlowsWiringOptions {
  statePath: string | null;
  openPrs: () => readonly MyPr[];
  linkedSession: (prKey: string) => PasteTarget | null;
  readConfigFile: () => Promise<unknown>;
  appendRule: (rule: PrFlowRule) => Promise<boolean>;
  github: { replyToReviewThread(threadId: string, body: string): GithubWrite; resolveReviewThread(threadId: string): GithubWrite; unresolveReviewThread(threadId: string): GithubWrite };
  broadcast: (frame: PrFlowsStatus) => void;
  log: Pick<Console, 'warn'>;
  now?: () => number;
}

type Disposal = { request: PrFlowDisposeRequest; ruleName: string | null };

function createPrFlowsWiring({ statePath, openPrs, linkedSession, readConfigFile, appendRule, github, broadcast, log, now = Date.now }: PrFlowsWiringOptions) {
  let state: PrFlowsState = { handledByPr: {}, reopenedByPr: {} };
  let warnings: string[] = [];
  const store = createJsonStateStore({
    name: 'pr flows', filePath: statePath,
    parse: (raw) => PrFlowsState.safeParse(raw).data ?? null,
    adopt: (loadedState) => { state = loadedState ?? state; },
    warn: (message, fields) => log.warn(`[pr-flows] ${message} ${JSON.stringify(fields)}`),
  });
  const loaded = store.load();
  const repliedThreadIds = new Set<string>();
  const resolvedThreadIds = new Set<string>();
  const inFlightItemKeys = new Set<string>();

  function statusFrame(): PrFlowsStatus {
    return { type: 'pr-flows-status', handledByPr: state.handledByPr, warnings };
  }

  function findItem(request: PrFlowItemRequest): { pr: MyPr; item: PrFlowItem } | null {
    const pr = openPrs().find((candidate) => candidate.key === request.prKey);
    const item = pr?.reviewItems.find((candidate) => candidate.key === request.itemKey);
    return pr && item ? { pr, item } : null;
  }

  async function persist(nextState: PrFlowsState): Promise<void> {
    state = withOnlyOpenPrs(nextState, new Set(openPrs().map((pr) => pr.key)));
    const persistedState = state;
    await store.write(persistedState, () => `${JSON.stringify(persistedState, null, 2)}\n`);
    broadcast(statusFrame());
  }

  function threadIdsOf(item: PrFlowItem): string[] {
    return item.sources.flatMap((source) => (source.threadId === undefined ? [] : [source.threadId]));
  }

  async function recordHandled({ request, ruleName }: Disposal, item: PrFlowItem): Promise<void> {
    await loaded;
    const handled = {
      itemKey: item.key, dismissalKeys: item.sources.map((source) => source.dismissalKey), action: request.action, location: itemLocation(item),
      reason: request.reason ?? null, at: now(), ruleName, threadIds: request.action === 'dismiss' ? threadIdsOf(item) : [],
    };
    await persist(withHandled(state, request.prKey, handled));
  }

  async function dismissThreads(item: PrFlowItem, reason: string): Promise<string | null> {
    for (const threadId of threadIdsOf(item)) {
      if (resolvedThreadIds.has(threadId)) continue;
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

  async function fixLocally(disposal: Disposal, pr: MyPr, item: PrFlowItem): Promise<PrFlowDisposeResult> {
    const session = linkedSession(disposal.request.prKey);
    if (!session) return { ok: false, error: 'No live session is linked to this pull request.' };
    if (session.hasPendingPaste()) return { ok: false, error: 'The linked session already has a prompt waiting to be pasted, so nothing was sent.' };
    const fence = (label: string, text: string) => fencedUntrusted(label, text, UNTRUSTED_COMMENT_MAX_CHARS);
    const pasted = session.pasteTextWhenReady(fixLocallyPrompt(pr.url, item, fence), { submit: disposal.ruleName === null });
    if (!pasted.ok) return { ok: false, error: `Could not write to the linked session (${pasted.reason ?? 'unknown reason'}).` };
    if (pasted.deferred === true && disposal.ruleName === null) return { ok: true, isPending: true };
    await recordHandled(disposal, item);
    return { ok: true };
  }

  async function disposeFound(disposal: Disposal, pr: MyPr, item: PrFlowItem): Promise<PrFlowDisposeResult> {
    if (disposal.request.action === 'fix-local') return fixLocally(disposal, pr, item);
    const failure = await dismissThreads(item, disposal.request.reason ?? '');
    if (failure) return { ok: false, error: failure };
    await recordHandled(disposal, item);
    return { ok: true };
  }

  async function disposeGuarded(disposal: Disposal): Promise<PrFlowDisposeResult> {
    const found = findItem(disposal.request);
    if (!found) return { ok: false, error: 'That review item is no longer open on this pull request.' };
    if (inFlightItemKeys.has(found.item.key)) return { ok: false, error: 'That review item is already being handled.' };
    inFlightItemKeys.add(found.item.key);
    try {
      return await disposeFound(disposal, found.pr, found.item);
    } finally {
      inFlightItemKeys.delete(found.item.key);
    }
  }

  function dispose(request: PrFlowDisposeRequest): Promise<PrFlowDisposeResult> {
    return disposeGuarded({ request, ruleName: null });
  }

  async function undo(request: PrFlowItemRequest): Promise<PrFlowDisposeResult> {
    await loaded;
    const { undone } = withReopened(state, request.prKey, request.itemKey);
    if (undone.length === 0) return { ok: false, error: 'That review item is not in the Handled list.' };
    for (const threadId of undone.flatMap((entry) => entry.threadIds)) {
      const unresolved = await github.unresolveReviewThread(threadId);
      if (!unresolved.ok) return { ok: false, error: `Could not reopen the thread on GitHub: ${unresolved.err}` };
      resolvedThreadIds.delete(threadId);
      repliedThreadIds.delete(threadId);
    }
    await persist(withReopened(state, request.prKey, request.itemKey).state);
    return { ok: true };
  }

  async function saveRule(request: PrFlowSaveRuleRequest): Promise<PrFlowDisposeResult> {
    const found = findItem(request);
    if (!found) return { ok: false, error: 'That review item is no longer open on this pull request.' };
    const rule = PrFlowRule.safeParse(savedRuleFor(found.item, request.reason));
    if (!rule.success) return { ok: false, error: `Could not build a rule for this item: ${rule.error.issues[0]?.message ?? 'invalid rule'}` };
    const isSaved = await appendRule(rule.data);
    return isSaved ? { ok: true } : { ok: false, error: 'Could not save the rule to config.json.' };
  }

  let isApplyingRules = false;

  async function applyRules(): Promise<void> {
    if (isApplyingRules) return;
    isApplyingRules = true;
    try {
      await applyRulesOnce();
    } finally {
      isApplyingRules = false;
    }
  }

  async function applyRulesOnce(): Promise<void> {
    await loaded;
    const configFile = await readConfigFile();
    const nextWarnings = new Set<string>();
    for (const pr of openPrs()) {
      const { rules, warnings: ruleWarnings } = prFlowRules(configFile, pr.repo);
      for (const warning of [...ruleWarnings, ...unknownActionWarnings(rules, new Set())]) nextWarnings.add(warning);
      for (const planned of plannedActions(pr.key, pr.reviewItems, rules, state)) {
        const request = { prKey: pr.key, itemKey: planned.item.key, action: planned.action, ...(planned.rule.reason === undefined ? {} : { reason: planned.rule.reason }) };
        const outcome = await disposeGuarded({ request, ruleName: planned.rule.name });
        if (!outcome.ok) nextWarnings.add(`Rule '${planned.rule.name}' could not ${planned.action} ${itemLocation(planned.item)} on ${pr.key}: ${outcome.error ?? 'unknown error'}`);
      }
    }
    const changed = [...nextWarnings].join('\n') !== warnings.join('\n');
    warnings = [...nextWarnings];
    if (changed) broadcast(statusFrame());
  }

  return { statusFrame, dispose, undo, saveRule, applyRules };
}

type PrFlowsWiring = ReturnType<typeof createPrFlowsWiring>;

export { createPrFlowsWiring };
export type { PrFlowsWiring };
