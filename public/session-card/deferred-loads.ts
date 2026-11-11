import { describeFailure } from '../client-error-core.ts';
import { reportToServerLog } from '../control-ws.ts';

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

export { loadResumeDialog };
