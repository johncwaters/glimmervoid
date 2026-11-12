import crypto from 'node:crypto';
import type { MyPr } from '../../shared/contracts/my-prs.ts';
import { PR_ACTION_REPORT_URL_ENV, PR_ACTION_TOKEN_ENV, PrFlowRule, PrFlowsState } from '../../shared/contracts/pr-flows.ts';
import type { PrActionReportBody, PrActionRunRecord, PrActionRunRequest, PrActionRunView, PrFlowPrAction, PrFlowActionChoice, PrFlowActionOutput, PrFlowActionRunStatus, PrFlowApproveRequest, PrFlowCommand, PrFlowDisposeRequest, PrFlowDisposeResult, PrFlowItem, PrFlowItemRequest, PrFlowPendingApproval, PrFlowSaveRuleRequest, PrFlowSourceOutput, PrFlowSourceRunStatus, PrFlowsStatus } from '../../shared/contracts/pr-flows.ts';
import { createJsonStateStore } from '../json-file.ts';
import { fencedUntrusted } from '../lanes/core/lane-report-core.ts';
import { acceptReport, branchMovedNote, isCommandStillRunning, newPrActionRun, commandFingerprint, prActionRunAfterExit, prFlowSetup, prFlowsConfig, visibleRun, withInterruptedRuns, withPrActionRun, fixLocallyPrompt, itemLocation, mergeItems, plannedActions, savedRuleFor, scopedToRepo, shouldTellBranchMoved, withRuleRun, sourceCandidates, threadCandidates, withHandled, withOnlyOpenPrs, withReopened } from './core/pr-flows-core.ts';
import type { PrFlowsExternal } from './pr-flows-external.ts';
import type { PackOnDisk } from '../../shared/contracts/pack.ts';
import { clock } from '../../shared/clock.ts';
import type { DeliverOptions, DeliveryOutcome } from '../../session/core/input-delivery-core.ts';

const UNTRUSTED_COMMENT_MAX_CHARS = 4000;

interface PasteTarget {
  deliver(text: string, options: DeliverOptions): DeliveryOutcome;
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
  external?: PrFlowsExternal;
  broadcast: (frame: PrFlowsStatus) => void;
  log: Pick<Console, 'warn'>;
  reportUrlFor?: (runId: string) => string | null;
  loadPacks?: (configFile: unknown) => Promise<{ packs: PackOnDisk[]; warnings: string[] }>;
  now?: () => number;
}

const NO_EXTERNAL_RUNNER: PrFlowsExternal = {
  runSource: async () => ({ ok: false, error: 'No command runner is wired.' }),
  runAction: async () => ({ outcome: 'failed', message: 'No command runner is wired.' }),
};

type Disposal = { request: PrFlowDisposeRequest; ruleName: string | null };
type SourceRun = { head: string; fingerprint: string; label: string; output: PrFlowSourceOutput | null; error: string | null; at: number };
type ActionRun = {
  itemKey: string; actionId: string; label: string; headAtStart: string; finishedAt: number | null;
  state: PrFlowActionRunStatus['state']; message: string; isBranchMoveTold: boolean;
};

const FAILED_SOURCE_RETRY_MS = 5 * 60 * 1000;
const BRANCH_MOVED_WINDOW_MS = 10 * 60 * 1000;

function createPrFlowsWiring({ statePath, openPrs, linkedSession, readConfigFile, appendRule, github, external = NO_EXTERNAL_RUNNER, broadcast, log, reportUrlFor = () => null, loadPacks = async () => ({ packs: [], warnings: [] }), now = clock.nowMs }: PrFlowsWiringOptions) {
  let state: PrFlowsState = { handledByPr: {}, reopenedByPr: {}, approvedFingerprints: [], ruleRunsByPr: {}, prActionRunByPr: {} };
  let warnings: string[] = [];
  let approvals: PrFlowPendingApproval[] = [];
  let runnableActions: PrFlowActionChoice[] = [];
  let approvedPrActions: PrFlowPrAction[] = [];
  const actionRunsByPr = new Map<string, ActionRun[]>();
  let lastFrameText = '';
  const sourceRunsByPr = new Map<string, Map<string, SourceRun>>();
  const inFlightSourceKeys = new Set<string>();
  const store = createJsonStateStore({
    name: 'pr flows', filePath: statePath,
    parse: (raw) => PrFlowsState.safeParse(raw).data ?? null,
    adopt: (loadedState) => { state = loadedState ? withInterruptedRuns(loadedState) : state; },
    warn: (message, fields) => log.warn(`[pr-flows] ${message} ${JSON.stringify(fields)}`),
  });
  const loaded = store.load();
  const repliedThreadIds = new Set<string>();
  const resolvedThreadIds = new Set<string>();
  const inFlightItemKeys = new Set<string>();

  function reviewItemsFor(pr: MyPr): PrFlowItem[] {
    const runs = [...(sourceRunsByPr.get(pr.key) ?? [])].filter(([, run]) => run.output !== null && run.head === pr.headRefOid);
    if (runs.length === 0) return pr.reviewItems;
    return mergeItems([...threadCandidates(pr.threads), ...runs.flatMap(([sourceId, run]) => sourceCandidates({ id: sourceId, label: run.label }, run.output?.findings ?? []))]);
  }

  function statusFrame(): PrFlowsStatus {
    const sourceRunsByPrKey: Record<string, PrFlowSourceRunStatus[]> = {};
    const reviewItemsByPr: Record<string, PrFlowItem[]> = {};
    const actionRunsByPrKey: Record<string, PrFlowActionRunStatus[]> = {};
    const prActionsByPr: Record<string, PrFlowActionChoice[]> = {};
    const prActionRunsByPr: Record<string, PrActionRunView[]> = {};
    for (const pr of openPrs()) {
      const prActionChoices = scopedToRepo(approvedPrActions, pr.repo).map(({ id, label }) => ({ id, label }));
      if (prActionChoices.length > 0) prActionsByPr[pr.key] = prActionChoices;
      const prActionRuns = Object.values(state.prActionRunByPr[pr.key] ?? {}).flatMap((run) => visibleRun(run, pr) ?? []);
      if (prActionRuns.length > 0) prActionRunsByPr[pr.key] = prActionRuns;
      const actionRuns = actionRunsByPr.get(pr.key) ?? [];
      if (actionRuns.length > 0) actionRunsByPrKey[pr.key] = actionRuns.map(({ itemKey, actionId, label, state: runState, message }) => ({ itemKey, actionId, label, state: runState, message }));
      const runs = [...(sourceRunsByPr.get(pr.key)?.values() ?? [])];
      if (runs.length === 0) continue;
      sourceRunsByPrKey[pr.key] = runs.map((run) => ({ label: run.label, status: run.output?.status ?? [], error: run.error }));
      reviewItemsByPr[pr.key] = reviewItemsFor(pr);
    }
    return {
      type: 'pr-flows-status', handledByPr: state.handledByPr, warnings, pendingApprovals: approvals, sourceRunsByPr: sourceRunsByPrKey, reviewItemsByPr,
      actions: runnableActions, actionRunsByPr: actionRunsByPrKey, prActionsByPr, prActionRunsByPr,
    };
  }

  function broadcastIfChanged(): void {
    const frame = statusFrame();
    const frameText = JSON.stringify(frame);
    if (frameText === lastFrameText) return;
    lastFrameText = frameText;
    broadcast(frame);
  }

  function findItem(request: PrFlowItemRequest): { pr: MyPr; item: PrFlowItem } | null {
    const pr = openPrs().find((candidate) => candidate.key === request.prKey);
    const item = pr ? reviewItemsFor(pr).find((candidate) => candidate.key === request.itemKey) : undefined;
    return pr && item ? { pr, item } : null;
  }

  async function persist(nextState: PrFlowsState): Promise<void> {
    state = withOnlyOpenPrs(nextState, new Set(openPrs().map((pr) => pr.key)));
    const persistedState = state;
    await store.write(persistedState, () => `${JSON.stringify(persistedState, null, 2)}\n`);
    broadcastIfChanged();
  }

  function threadIdsOf(item: PrFlowItem): string[] {
    return item.sources.flatMap((source) => (source.threadId === undefined ? [] : [source.threadId]));
  }

  async function recordHandled({ request, ruleName }: Disposal, item: PrFlowItem, actionLabel?: string): Promise<void> {
    await loaded;
    const handled = {
      itemKey: item.key, dismissalKeys: item.sources.map((source) => source.dismissalKey), action: request.action, location: itemLocation(item),
      reason: request.reason ?? null, at: now(), ruleName, threadIds: request.action === 'dismiss' ? threadIdsOf(item) : [],
      ...(actionLabel === undefined ? {} : { actionLabel }),
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
    const pasted = session.deliver(fixLocallyPrompt(pr.url, item, fence), { when: 'ready', submit: disposal.ruleName === null });
    if (!pasted.ok) return { ok: false, error: `Could not write to the linked session (${pasted.reason}).` };
    if (pasted.kind === 'queued' && disposal.ruleName === null) return { ok: true, isPending: true };
    await recordHandled(disposal, item);
    return { ok: true };
  }

  async function currentSetup() {
    await loaded;
    const configFile = await readConfigFile();
    return prFlowSetup(prFlowsConfig(configFile), await loadPacks(configFile), state.approvedFingerprints);
  }

  async function runnableActionCommands(): Promise<PrFlowCommand[]> {
    const setup = await currentSetup();
    return setup.commands.actions.filter((action) => setup.approved.has(commandFingerprint('action', action)));
  }

  async function finishActionRun(disposal: Disposal, item: PrFlowItem, run: ActionRun, output: PrFlowActionOutput): Promise<void> {
    run.finishedAt = now();
    run.state = output.outcome;
    run.message = output.message;
    if (output.outcome === 'done' || output.outcome === 'started') await recordHandled(disposal, item, run.label);
    void applyRules();
  }

  async function startActionRun(disposal: Disposal, pr: MyPr, item: PrFlowItem): Promise<PrFlowDisposeResult> {
    const actionId = disposal.request.action.slice('run:'.length);
    const action = (await runnableActionCommands()).find((candidate) => candidate.id === actionId);
    if (!action) return { ok: false, error: 'That action is not in prFlows.actions, or it waits for your approval in My PRs.' };
    const runs = actionRunsByPr.get(pr.key) ?? [];
    if (runs.some((run) => run.actionId === actionId && run.finishedAt === null)) return { ok: false, error: `${action.label} is already running on this pull request.` };
    const run: ActionRun = { itemKey: item.key, actionId, label: action.label, headAtStart: pr.headRefOid, finishedAt: null, state: 'running', message: '', isBranchMoveTold: false };
    actionRunsByPr.set(pr.key, [...runs.filter((existing) => existing.actionId !== actionId || existing.itemKey !== item.key), run]);
    if (disposal.ruleName !== null) await persist(withRuleRun(state, pr.key, { itemKey: item.key, actionId, head: pr.headRefOid }));
    broadcastIfChanged();
    void external.runAction(action, pr, item).then((output) => finishActionRun(disposal, item, run, output));
    return { ok: true };
  }

  async function finishPrActionRun(prKey: string, startedRun: PrActionRunRecord, output: PrFlowActionOutput): Promise<void> {
    const current = state.prActionRunByPr[prKey]?.[startedRun.actionId];
    if (current?.runId !== startedRun.runId || !isCommandStillRunning(current)) return;
    const finished = prActionRunAfterExit(current, output, now());
    if (!finished) return;
    await persist(withPrActionRun(state, prKey, finished));
  }

  async function runPrAction(request: PrActionRunRequest): Promise<PrFlowDisposeResult> {
    const setup = await currentSetup();
    const pr = openPrs().find((candidate) => candidate.repo.toLowerCase() === request.repo.toLowerCase() && candidate.number === request.number);
    if (!pr) return { ok: false, error: 'That pull request is no longer open.' };
    if (pr.headRefOid !== request.head) return { ok: false, error: 'The pull request has a new head since this view loaded; check it and click again.' };
    const action = scopedToRepo(setup.commands.prActions, pr.repo).find((candidate) => candidate.id === request.actionId && setup.approved.has(commandFingerprint('pr-action', candidate)));
    if (!action) return { ok: false, error: 'That action is not in prFlows.prActions for this repository, or it waits for your approval in My PRs.' };
    const currentRun = state.prActionRunByPr[pr.key]?.[action.id];
    if (currentRun && isCommandStillRunning(currentRun)) return { ok: false, error: `${action.label} is already running on this pull request.` };
    const runId = crypto.randomUUID();
    const reportUrl = reportUrlFor(runId);
    const reportToken = reportUrl === null ? null : crypto.randomBytes(32).toString('base64url');
    const run = newPrActionRun({ runId, actionId: action.id, label: action.label, head: pr.headRefOid, startedAt: now(), reportToken });
    await persist(withPrActionRun(state, pr.key, run));
    const reportEnv: Record<string, string> = reportUrl === null || reportToken === null ? {} : { [PR_ACTION_REPORT_URL_ENV]: reportUrl, [PR_ACTION_TOKEN_ENV]: reportToken };
    void external.runAction(action, pr, undefined, reportEnv).then((output) => finishPrActionRun(pr.key, run, output));
    return { ok: true };
  }

  async function acceptPrActionReport(runId: string, presentedToken: string, body: PrActionReportBody): Promise<200 | 401 | 404 | 409> {
    await loaded;
    const reported = Object.entries(state.prActionRunByPr)
      .flatMap(([prKey, runsByAction]) => Object.values(runsByAction).filter((run) => run.runId === runId).map((run) => ({ prKey, run })))[0];
    if (!reported) return 404;
    const verdict = acceptReport(reported.run, presentedToken, body, now());
    if (!verdict.ok) return verdict.status;
    await persist(withPrActionRun(state, reported.prKey, verdict.run));
    return 200;
  }

  function tellBranchMoved(pr: MyPr): void {
    const dueRuns = (actionRunsByPr.get(pr.key) ?? []).filter((run) => !run.isBranchMoveTold && shouldTellBranchMoved(run, pr.headRefOid, now(), BRANCH_MOVED_WINDOW_MS));
    if (dueRuns.length === 0) return;
    const session = linkedSession(pr.key);
    if (!session || session.hasPendingPaste()) return;
    const pasted = session.deliver(branchMovedNote(pr.url, [...new Set(dueRuns.map((run) => run.label))], pr.headRefOid), { when: 'ready', submit: true });
    if (!pasted.ok) return;
    for (const run of dueRuns) run.isBranchMoveTold = true;
  }

  function hasActionRunAtHead(pr: MyPr, itemKey: string, action: string): boolean {
    const actionId = action.slice('run:'.length);
    const isRunning = (actionRunsByPr.get(pr.key) ?? []).some((run) => run.actionId === actionId && run.finishedAt === null);
    return isRunning || (state.ruleRunsByPr[pr.key] ?? []).some((run) => run.actionId === actionId && run.itemKey === itemKey && run.head === pr.headRefOid);
  }

  async function disposeFound(disposal: Disposal, pr: MyPr, item: PrFlowItem): Promise<PrFlowDisposeResult> {
    if (disposal.request.action.startsWith('run:')) return startActionRun(disposal, pr, item);
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
    const rule = PrFlowRule.safeParse(savedRuleFor(found.item, found.pr.repo, request.reason));
    if (!rule.success) return { ok: false, error: `Could not build a rule for this item: ${rule.error.issues[0]?.message ?? 'invalid rule'}` };
    const isSaved = await appendRule(rule.data);
    return isSaved ? { ok: true } : { ok: false, error: 'Could not save the rule to config.json.' };
  }

  async function approve(request: PrFlowApproveRequest): Promise<PrFlowDisposeResult> {
    const setup = await currentSetup();
    if (!setup.approvals.some((pending) => pending.fingerprint === request.fingerprint)) {
      return { ok: false, error: 'That entry changed or is already approved; check the list again.' };
    }
    await persist({ ...state, approvedFingerprints: [...state.approvedFingerprints, request.fingerprint] });
    void applyRules();
    return { ok: true };
  }

  async function runSourceFor(pr: MyPr, source: PrFlowCommand, fingerprint: string): Promise<void> {
    const runKey = `${pr.key}\n${source.id}`;
    if (inFlightSourceKeys.has(runKey)) return;
    inFlightSourceKeys.add(runKey);
    try {
      const outcome = await external.runSource(source, pr);
      const runs = sourceRunsByPr.get(pr.key) ?? new Map<string, SourceRun>();
      runs.set(source.id, { head: pr.headRefOid, fingerprint, label: source.label, output: outcome.ok ? outcome.output : null, error: outcome.ok ? null : outcome.error, at: now() });
      sourceRunsByPr.set(pr.key, runs);
    } finally {
      inFlightSourceKeys.delete(runKey);
    }
    void applyRules();
  }

  function startDueSources(pr: MyPr, sources: readonly PrFlowCommand[], approved: ReadonlySet<string>): void {
    const runs = sourceRunsByPr.get(pr.key);
    for (const source of sources) {
      const fingerprint = commandFingerprint('source', source);
      if (!approved.has(fingerprint)) continue;
      const lastRun = runs?.get(source.id);
      const isCurrent = lastRun?.head === pr.headRefOid && lastRun.fingerprint === fingerprint;
      if (isCurrent && (lastRun.output !== null || now() - lastRun.at < FAILED_SOURCE_RETRY_MS)) continue;
      void runSourceFor(pr, source, fingerprint);
    }
  }

  function forgetUnconfiguredSourceRuns(openPrKeys: ReadonlySet<string>, sources: readonly PrFlowCommand[], approved: ReadonlySet<string>): void {
    const liveFingerprints = new Set(sources.map((source) => commandFingerprint('source', source)).filter((fingerprint) => approved.has(fingerprint)));
    for (const [prKey, runs] of sourceRunsByPr) {
      if (!openPrKeys.has(prKey)) {
        sourceRunsByPr.delete(prKey);
        continue;
      }
      for (const [sourceId, run] of runs) if (!liveFingerprints.has(run.fingerprint)) runs.delete(sourceId);
    }
    for (const prKey of actionRunsByPr.keys()) if (!openPrKeys.has(prKey)) actionRunsByPr.delete(prKey);
  }

  let runningApply: Promise<void> | null = null;
  let isApplyRequested = false;

  async function applyRulesUntilSettled(): Promise<void> {
    try {
      do {
        isApplyRequested = false;
        await applyRulesOnce();
      } while (isApplyRequested);
    } finally {
      runningApply = null;
    }
  }

  function applyRules(): Promise<void> {
    if (runningApply) {
      isApplyRequested = true;
      return runningApply;
    }
    runningApply = applyRulesUntilSettled();
    return runningApply;
  }

  async function applyRulesOnce(): Promise<void> {
    const setup = await currentSetup();
    const { commands, approved } = setup;
    const nextWarnings = new Set<string>(commands.warnings);
    const prs = openPrs();
    forgetUnconfiguredSourceRuns(new Set(prs.map((pr) => pr.key)), commands.sources, approved);
    approvals = setup.approvals;
    approvedPrActions = commands.prActions.filter((action) => approved.has(commandFingerprint('pr-action', action)));
    runnableActions = commands.actions.filter((action) => approved.has(commandFingerprint('action', action))).map(({ id, label }) => ({ id, label }));
    const runnableActionIds = new Set(runnableActions.map((action) => action.id));
    for (const warning of setup.ruleWarnings) nextWarnings.add(warning);
    for (const pr of prs) {
      startDueSources(pr, scopedToRepo(commands.sources, pr.repo), approved);
      tellBranchMoved(pr);
      for (const planned of plannedActions(pr.key, reviewItemsFor(pr), scopedToRepo(setup.rules, pr.repo), state, runnableActionIds)) {
        if (planned.action.startsWith('run:') && hasActionRunAtHead(pr, planned.item.key, planned.action)) continue;
        const request = { prKey: pr.key, itemKey: planned.item.key, action: planned.action, ...(planned.rule.reason === undefined ? {} : { reason: planned.rule.reason }) };
        const outcome = await disposeGuarded({ request, ruleName: planned.rule.name });
        if (!outcome.ok) nextWarnings.add(`Rule '${planned.rule.name}' could not ${planned.action} ${itemLocation(planned.item)} on ${pr.key}: ${outcome.error ?? 'unknown error'}`);
      }
    }
    warnings = [...nextWarnings];
    broadcastIfChanged();
  }

  return { statusFrame, dispose, undo, saveRule, approve, applyRules, runPrAction, acceptPrActionReport };
}

type PrFlowsWiring = ReturnType<typeof createPrFlowsWiring>;

export { createPrFlowsWiring };
export type { PrFlowsWiring };
