import { CLIENT_ERROR_NAME_MAX_CHARS, CLIENT_ERROR_STACK_MAX_CHARS, CLIENT_LOG_SCOPE_MAX_CHARS, CLIENT_LOG_TEXT_MAX_CHARS } from '#shared/contracts/control-messages.ts';
import type { ClientErrorReport } from '#shared/contracts/control-messages.ts';

const MAX_REPORTS_PER_PAGE = 32;
const STACK_FRAME_LINE = /^\s*at .+:\d+:\d+\)?$|^[^@\s]*@.+:\d+:\d+$/;

type SendReport = (message: Record<string, unknown>) => boolean;

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

function createOncePerKeySender(sendReport: SendReport, maxReports: number): (reportKey: string, message: Record<string, unknown>) => void {
  const reportedKeys = new Set<string>();
  return (reportKey, message) => {
    if (reportedKeys.has(reportKey) || reportedKeys.size >= maxReports) return;
    if (!sendReport(message)) return;
    reportedKeys.add(reportKey);
  };
}

function createClientErrorReporter(sendReport: SendReport): (reason: unknown) => void {
  const sendOnce = createOncePerKeySender(sendReport, MAX_REPORTS_PER_PAGE);
  return (reason) => {
    const report = buildClientErrorReport(reason);
    if (!report) return;
    sendOnce(`${report.name}\n${report.stack}`, { type: 'client-error', ...report });
  };
}

function describeFailure(reason: unknown): string {
  if (!(reason instanceof Error)) return `${typeof reason}: ${String(reason)}`;
  const topFrame = stackFramesOnly(reason).split('\n')[0]?.trim() ?? '';
  return [`${reason.name || 'Error'}: ${reason.message}`, topFrame].filter(Boolean).join(' ');
}

function describeSchemaIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues.slice(0, 5).map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ');
}

function frameTypeOf(rawFrame: unknown): string {
  if (typeof rawFrame !== 'object' || rawFrame === null || !('type' in rawFrame)) return '(untyped)';
  return String(rawFrame.type);
}

function createClientLogReporter(sendReport: SendReport): { report: (scope: string, text: string) => void; flushUnsent: () => void } {
  const unsentLogLines: Record<string, unknown>[] = [];
  const sendOrHold: SendReport = (message) => {
    if (!sendReport(message)) unsentLogLines.push(message);
    return true;
  };
  const sendOnce = createOncePerKeySender(sendOrHold, MAX_REPORTS_PER_PAGE);
  return {
    report(scope, text) {
      const logLine = { scope: scope.slice(0, CLIENT_LOG_SCOPE_MAX_CHARS), text: text.slice(0, CLIENT_LOG_TEXT_MAX_CHARS) };
      sendOnce(`${logLine.scope}\n${logLine.text}`, { type: 'client-log', ...logLine });
    },
    flushUnsent() {
      while (unsentLogLines.length > 0) {
        const oldestLogLine = unsentLogLines[0];
        if (!oldestLogLine || !sendReport(oldestLogLine)) return;
        unsentLogLines.shift();
      }
    },
  };
}

export { createClientErrorReporter, createClientLogReporter, describeFailure, describeSchemaIssues, frameTypeOf };
