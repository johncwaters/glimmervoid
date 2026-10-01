import { CLIENT_ERROR_NAME_MAX_CHARS, CLIENT_ERROR_STACK_MAX_CHARS } from '#shared/contracts/control-messages.ts';
import type { ClientErrorReport } from '#shared/contracts/control-messages.ts';

const MAX_CLIENT_ERROR_REPORTS = 32;
const STACK_FRAME_LINE = /^\s*at .+:\d+:\d+\)?$|^[^@\s]*@.+:\d+:\d+$/;

function stackFramesOnly(error: Error): string {
  const stack = error.stack ?? '';
  const header = String(error);
  const withoutHeader = stack.startsWith(header) ? stack.slice(header.length) : stack;
  return withoutHeader.split('\n').filter((line) => STACK_FRAME_LINE.test(line)).join('\n');
}

function buildClientErrorReport(reason: unknown): ClientErrorReport | null {
  if (reason === null || reason === undefined) return null;
  if (!(reason instanceof Error)) return { name: 'NonError', stack: '' };
  return {
    name: (reason.name || 'Error').slice(0, CLIENT_ERROR_NAME_MAX_CHARS),
    stack: stackFramesOnly(reason).slice(0, CLIENT_ERROR_STACK_MAX_CHARS),
  };
}

function createClientErrorReporter(sendReport: (message: Record<string, unknown>) => boolean): (reason: unknown) => void {
  const reportedErrorKeys = new Set<string>();
  return (reason) => {
    const report = buildClientErrorReport(reason);
    if (!report) return;
    const errorKey = `${report.name}\n${report.stack}`;
    if (reportedErrorKeys.has(errorKey) || reportedErrorKeys.size >= MAX_CLIENT_ERROR_REPORTS) return;
    if (!sendReport({ type: 'client-error', ...report })) return;
    reportedErrorKeys.add(errorKey);
  };
}

export { MAX_CLIENT_ERROR_REPORTS, buildClientErrorReport, createClientErrorReporter };
