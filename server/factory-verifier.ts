import { CoherenceWorkInspect } from '../shared/contracts/coherence.ts';
import type { Config } from '../shared/contracts/config.ts';
import { errorMessage } from '../shared/text.ts';
import { FactoryConsequences } from '../shared/contracts/factory.ts';
import type { FactoryLaneState, FactoryProjectState, FactoryWorkerEvent } from '../shared/contracts/factory.ts';
import { FACTORY_LEDGER_SESSION, buildVerifierPrompt, decideIntentClose, evidenceNamesOnlySha, findFactoryProjectPath, verifierDefectEvidence, verifierRejectionNote } from './core/factory-core.ts';
import { runFactoryReview } from './factory-closeout.ts';
import type { LaneSpawn } from './lane-spawn.ts';

interface FactoryVerifierDeps {
  config: Pick<Config, 'factory' | 'projects'>;
  spawnVerifier: LaneSpawn;
  serializeProject: <T>(projectId: string, operation: () => Promise<T>) => Promise<T>;
  ensureLedger: (projectId: string, projectPath: string) => Promise<{ cwd: string }>;
  ensureControlCheckout: (args: { projectId: string; projectPath: string; sha: string }) => Promise<string>;
  hasCodeChangedSince: (projectPath: string, sha: string) => Promise<boolean>;
  readLaneState: (projectId: string) => Promise<FactoryLaneState>;
  writeLaneState: (projectId: string, state: FactoryLaneState) => Promise<void>;
  runCoherence: (request: { cwd: string; args: string[] }) => Promise<string>;
  commitAndLand: (projectId: string, projectPath: string, message: string) => Promise<void>;
  pause: (projectId: string) => Promise<void>;
  setException: (projectId: string, reason: string) => void;
  notifyOrchestrator: (projectId: string, event: FactoryWorkerEvent) => void;
  stopOrchestrator: (projectId: string) => void;
  onChanged: () => void;
}

export function createFactoryVerifier({ config, spawnVerifier, serializeProject, ensureLedger, ensureControlCheckout,
  hasCodeChangedSince, readLaneState, writeLaneState, runCoherence, commitAndLand, pause, setException, notifyOrchestrator, stopOrchestrator, onChanged }: FactoryVerifierDeps) {
  const readyByProject = new Map<string, string>();
  const notesByProject = new Map<string, string>();
  const checkedIntents = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  const controller = new AbortController();
  let stopped = false;
  const isEnabled = () => !stopped && config.factory?.enabled === true;
  const verifierLinkId = (intentId: string) => `verifier-${intentId}`;

  function trustedShasById(state: FactoryLaneState): ReadonlyMap<string, string> {
    return new Map((state.trustedVerifications ?? []).map(({ id, sha }) => [id, sha]));
  }

  async function hasFactoryVerification(cwd: string, workId: string, candidateIds: string[], trustedShas: ReadonlyMap<string, string>): Promise<boolean> {
    if (!candidateIds.some((candidateId) => trustedShas.has(candidateId))) return false;
    const consequences = FactoryConsequences.parse(JSON.parse(await runCoherence({ cwd, args: ['consequence', 'inspect', `work:${workId}`, '--json'] })));
    return consequences.records.some((record) => {
      const trustedSha = trustedShas.get(record.from.id);
      return record.relation === 'verifies' && record.from.kind === 'verification' && candidateIds.includes(record.from.id)
        && trustedSha !== undefined && evidenceNamesOnlySha(record.evidence, trustedSha) && record.to.kind === 'work' && record.to.id === workId;
    });
  }

  async function hasTrustedIntentClose(projectId: string, cwd: string, intentId: string): Promise<boolean> {
    const state = await readLaneState(projectId);
    if (!(state.trustedIntentCloses ?? []).includes(intentId)) return false;
    return hasFactoryVerification(cwd, intentId, [verifierLinkId(intentId)], trustedShasById(state));
  }

  async function readWatchVerifiedWorkIds(projectId: string, projectPath: string, workIds: string[]): Promise<Set<string>> {
    return serializeProject(projectId, async () => {
      const ledger = await ensureLedger(projectId, projectPath);
      const trustedShas = trustedShasById(await readLaneState(projectId));
      const verified = new Set<string>();
      for (const workId of workIds) {
        if (await hasFactoryVerification(ledger.cwd, workId, [`watch-${workId}`, `unwatched-${workId}`], trustedShas)) verified.add(workId);
      }
      return verified;
    });
  }

  async function haveIntentChildrenChanged(cwd: string, intentId: string, verifiedChildren: FactoryProjectState['orders']): Promise<boolean> {
    const inspected = CoherenceWorkInspect.parse(JSON.parse(await runCoherence({ cwd, args: ['work', 'inspect', '--json'] })));
    const currentChildIds = new Set(inspected.work.filter((order) => order.opened.parent === intentId).map((order) => order.work));
    return currentChildIds.size !== verifiedChildren.length || verifiedChildren.some((child) => !currentChildIds.has(child.id));
  }

  async function recordRejection(projectId: string, projectPath: string, intentId: string, findings: string[]): Promise<void> {
    notesByProject.set(projectId, verifierRejectionNote(intentId, findings));
    try {
      await serializeProject(projectId, async () => {
        if (!isEnabled()) return;
        const ledger = await ensureLedger(projectId, projectPath);
        await runCoherence({ cwd: ledger.cwd, args: ['defect', `verifier rejected ${intentId}`,
          '--evidence', verifierDefectEvidence(findings), '--session', FACTORY_LEDGER_SESSION] });
        await commitAndLand(projectId, projectPath, `factory: verifier rejected ${intentId}`);
      });
    } finally {
      notifyOrchestrator(projectId, { workId: intentId, event: 'verification failed' });
    }
  }

  async function verify(project: FactoryProjectState, projectPath: string, intent: FactoryProjectState['orders'][number], children: FactoryProjectState['orders']): Promise<void> {
    if (!project.headSha) return;
    const tipSha = project.headSha;
    const verificationId = verifierLinkId(intent.id);
    const cwd = await ensureControlCheckout({ projectId: project.projectId, projectPath, sha: tipSha });
    const verdict = await runFactoryReview({ spawnReviewer: spawnVerifier, model: config.factory?.verifierModel ?? null,
      signal: controller.signal, name: `Factory verifier ${intent.id}`, extraArgs: ['--add-dir', cwd],
      buildPrompt: () => buildVerifierPrompt({ projectName: project.projectName, intent, children, tipSha, checkoutPath: cwd }) });
    if (!isEnabled()) return;
    readyByProject.delete(project.projectId);
    if (!verdict.pass) {
      await recordRejection(project.projectId, projectPath, intent.id, verdict.findings);
      return;
    }
    notesByProject.delete(project.projectId);
    await serializeProject(project.projectId, async () => {
      if (!isEnabled()) return;
      if (await hasCodeChangedSince(projectPath, tipSha)) {
        notifyOrchestrator(project.projectId, { workId: intent.id, event: 'verification stale', detail: 'Integration tip changed; report ready after reassessing' });
        return;
      }
      const ledger = await ensureLedger(project.projectId, projectPath);
      if (await haveIntentChildrenChanged(ledger.cwd, intent.id, children)) {
        notifyOrchestrator(project.projectId, { workId: intent.id, event: 'verification stale', detail: 'Intent children changed; report ready after reassessing' });
        return;
      }
      await runCoherence({ cwd: ledger.cwd, args: ['consequence', 'add', `verification:${verificationId}`, 'verifies', `work:${intent.id}`,
        '--evidence', `Independent verifier passed every intent criterion at ${tipSha}`, '--session', FACTORY_LEDGER_SESSION, '--json'] });
      await runCoherence({ cwd: ledger.cwd, args: ['work', 'close', intent.id, 'completed', '--because', 'Independent factory verifier passed',
        '--session', FACTORY_LEDGER_SESSION, '--evidence', tipSha, ...children.flatMap((child) => ['--synthesized', child.id])] });
      await commitAndLand(project.projectId, projectPath, `factory: verify and close ${intent.id}`);
      const state = await readLaneState(project.projectId);
      await writeLaneState(project.projectId, { ...state,
        trustedVerifications: [...(state.trustedVerifications ?? []).filter(({ id }) => id !== verificationId), { id: verificationId, sha: tipSha }],
        trustedIntentCloses: [...new Set([...(state.trustedIntentCloses ?? []), intent.id])] });
      checkedIntents.add(`${project.projectId}:${intent.id}`);
      stopOrchestrator(project.projectId);
    });
  }

  async function tick(reported: FactoryProjectState): Promise<FactoryProjectState> {
    if (!isEnabled()) return reported;
    const verifierNote = notesByProject.get(reported.projectId);
    const project: FactoryProjectState = verifierNote ? { ...reported, note: reported.note ? `${reported.note}\n${verifierNote}` : verifierNote } : reported;
    const projectPath = findFactoryProjectPath(config, project.projectId);
    if (!projectPath) return project;
    for (const intent of project.orders) {
      const checkedKey = `${project.projectId}:${intent.id}`;
      if (intent.parent !== null || intent.state !== 'completed' || checkedIntents.has(checkedKey)) continue;
      const hasLink = await serializeProject(project.projectId, async () => {
        const ledger = await ensureLedger(project.projectId, projectPath);
        return hasTrustedIntentClose(project.projectId, ledger.cwd, intent.id);
      });
      if (decideIntentClose({ intent, children: [], verifiedWorkIds: new Set(hasLink ? [intent.id] : []), orchestratorSaidReady: false }) === 'close-without-verifier') {
        const reason = `Factory intent ${intent.id} closed without its independent verifier link`;
        await pause(project.projectId);
        checkedIntents.add(checkedKey);
        setException(project.projectId, reason);
        return { ...project, paused: true, error: reason };
      }
      checkedIntents.add(checkedKey);
    }
    const intentId = readyByProject.get(project.projectId);
    const intent = project.orders.find((order) => order.id === intentId && order.parent === null);
    if (pending.has(project.projectId)) return { ...project, verifierIntentIds: intentId ? [intentId] : [] };
    if (project.paused || project.error || !intent) return project;
    const children = project.orders.filter((order) => order.parent === intent.id);
    const completedChildIds = children.filter((order) => order.state === 'completed').map((order) => order.id);
    const verifiedWorkIds = await readWatchVerifiedWorkIds(project.projectId, projectPath, completedChildIds);
    const decision = decideIntentClose({ intent, children, verifiedWorkIds, orchestratorSaidReady: true });
    if (decision !== 'verify' || !project.headSha || await hasCodeChangedSince(projectPath, project.headSha)) return project;
    const verifying = verify(project, projectPath, intent, children).catch((error: unknown) => {
      if (isEnabled()) setException(project.projectId, errorMessage(error));
    }).then(() => { pending.delete(project.projectId); onChanged(); });
    pending.set(project.projectId, verifying);
    return { ...project, verifierIntentIds: [intent.id] };
  }

  async function stop(): Promise<void> {
    stopped = true;
    controller.abort();
    await Promise.allSettled([...pending.values()]);
    readyByProject.clear();
    notesByProject.clear();
  }

  return { tick, stop, isVerifying: (projectId: string) => pending.has(projectId), ready: (projectId: string, intentId: string) => { if (isEnabled()) readyByProject.set(projectId, intentId); } };
}
