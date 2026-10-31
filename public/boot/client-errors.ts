import { createClientErrorReporter, describeFailure } from '../client-error-core.ts';
import { reportToServerLog, sendControlMsg } from '../control-ws.ts';
import { reloadOnceOnPreloadError } from '../view-registry.ts';

function wireClientErrorReporting() {
  const reportClientError = createClientErrorReporter(sendControlMsg);
  window.addEventListener('error', (event) => {
    reportClientError(event.error);
    reportToServerLog('uncaught', describeFailure(event.error ?? event.message));
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportClientError(event.reason);
    reportToServerLog('unhandled-rejection', describeFailure(event.reason));
  });
  reloadOnceOnPreloadError(() => window.sessionStorage);
}

export { wireClientErrorReporting };
