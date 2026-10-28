import { describeFailure } from '../client-error-core.ts';
import { reportToServerLog } from '../control-ws.ts';

type FirstRunChecklistModule = typeof import('./first-run-checklist.ts');

interface ChecklistPlacement {
  host: HTMLElement;
  isShown: boolean;
}

let loadedChecklist: FirstRunChecklistModule | null = null;
let pendingChecklistLoad: Promise<FirstRunChecklistModule | null> | null = null;
let isBoardRevealed = false;
let latestPlacement: ChecklistPlacement | null = null;

function loadChecklist(): Promise<FirstRunChecklistModule | null> {
  pendingChecklistLoad ??= import('./first-run-checklist.ts').then(
    (checklist) => {
      loadedChecklist = checklist;
      return checklist;
    },
    (error: unknown) => {
      pendingChecklistLoad = null;
      reportToServerLog('first-run', `first-run checklist failed to load: ${describeFailure(error)}`);
      return null;
    },
  );
  return pendingChecklistLoad;
}

export function showFirstRunChecklist(host: HTMLElement, isShown: boolean) {
  latestPlacement = { host, isShown };
  if (loadedChecklist) {
    loadedChecklist.showFirstRunChecklist(host, isShown);
    return;
  }
  if (!isShown || !isBoardRevealed) return;
  void loadChecklist().then((checklist) => {
    if (checklist && latestPlacement) checklist.showFirstRunChecklist(latestPlacement.host, latestPlacement.isShown);
  });
}

export function refreshFirstRunChecklist() {
  loadedChecklist?.refreshFirstRunChecklist();
}

export function revealFirstRunChecklist() {
  isBoardRevealed = true;
  if (latestPlacement) showFirstRunChecklist(latestPlacement.host, latestPlacement.isShown);
}
