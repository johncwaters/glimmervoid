import type { PlanDraftPush } from '#shared/contracts/plan-review.ts';
import { describeFailure } from '../client-error-core.ts';
import { reportToServerLog } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';

type ResumeDialogModule = typeof import('./resume-dialog.ts');

let pendingResumeDialogLoad: Promise<ResumeDialogModule | null> | null = null;

function loadResumeDialog(): Promise<ResumeDialogModule | null> {
  pendingResumeDialogLoad ??= import('./resume-dialog.ts').catch((error: unknown) => {
    pendingResumeDialogLoad = null;
    reportToServerLog('resume-dialog', `restart dialog failed to load: ${describeFailure(error)}`);
    return null;
  });
  return pendingResumeDialogLoad;
}

type PlanFaceModule = typeof import('../plan/plan-face.ts');
type PlanFaceController = ReturnType<PlanFaceModule['createPlanFace']>;
type PlanFaceDeps = Parameters<PlanFaceModule['createPlanFace']>[0];
type PlanFaceUpdate = Parameters<PlanFaceController['update']>[0];

let loadedPlanFaceModule: PlanFaceModule | null = null;
let planFaceModuleLoad: Promise<PlanFaceModule | null> | null = null;

function loadPlanFaceModule(): Promise<PlanFaceModule | null> {
  planFaceModuleLoad ??= import('../plan/plan-face.ts').then(
    (planFaceModule) => {
      loadedPlanFaceModule = planFaceModule;
      return planFaceModule;
    },
    () => {
      planFaceModuleLoad = null;
      return null;
    },
  );
  return planFaceModuleLoad;
}

function createDeferredPlanFace(deps: PlanFaceDeps): PlanFaceController {
  const placeholder = el('section', 'plan-face');
  placeholder.hidden = true;
  let face: PlanFaceController | null = null;
  let isLoading = false;
  let shownSessionId: string | null = null;
  const pendingUpdate: PlanFaceUpdate = {};
  const pendingDraftsByAgent = new Map<PlanDraftPush['agentId'], PlanDraftPush>();

  function adoptLoadedModule(planFaceModule: PlanFaceModule | null) {
    isLoading = false;
    if (deps.signal?.aborted) return;
    if (!planFaceModule) {
      deps.reportProblem('The plan view did not load. Open the plan again to retry.');
      if (shownSessionId !== null) deps.showTerminal();
      shownSessionId = null;
      return;
    }
    const loadedFace = planFaceModule.createPlanFace(deps);
    placeholder.replaceWith(loadedFace.el);
    loadedFace.update(pendingUpdate);
    for (const draft of pendingDraftsByAgent.values()) loadedFace.update({ draft });
    pendingDraftsByAgent.clear();
    face = loadedFace;
    if (shownSessionId !== null) loadedFace.show(shownSessionId);
  }

  return {
    get el() {
      return face?.el ?? placeholder;
    },
    show(id: string) {
      if (face) {
        face.show(id);
        return;
      }
      shownSessionId = id;
      if (isLoading) return;
      isLoading = true;
      void loadPlanFaceModule().then(adoptLoadedModule);
    },
    hide() {
      shownSessionId = null;
      face?.hide();
    },
    update(next: PlanFaceUpdate) {
      if (face) {
        face.update(next);
        return;
      }
      if (next.state) pendingUpdate.state = next.state;
      if (typeof next.isConnected === 'boolean') pendingUpdate.isConnected = next.isConnected;
      if (next.draft) pendingDraftsByAgent.set(next.draft.agentId, next.draft);
    },
  };
}

export { createDeferredPlanFace, loadResumeDialog, loadedPlanFaceModule };
