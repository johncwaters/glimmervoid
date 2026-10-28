import { CLIENT_ERROR_NAME_MAX_CHARS, CLIENT_ERROR_STACK_MAX_CHARS, CLIENT_LOG_SCOPE_MAX_CHARS, CLIENT_LOG_TEXT_MAX_CHARS, TELEMETRY_TEXT_MAX_CHARS } from '#shared/contracts/control-messages.ts';
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

function createOncePerKeySender(sendReport: SendReport, maxReports: number, onLimitReached?: () => void): (reportKey: string, message: Record<string, unknown>) => void {
  const reportedKeys = new Set<string>();
  let hasReachedLimit = false;
  return (reportKey, message) => {
    if (reportedKeys.has(reportKey)) return;
    if (reportedKeys.size >= maxReports) {
      if (!hasReachedLimit) onLimitReached?.();
      hasReachedLimit = true;
      return;
    }
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

function createHoldingSender(sendReport: SendReport): { sendOrHold: SendReport; flushUnsent: () => void } {
  const unsentMessages: Record<string, unknown>[] = [];
  return {
    sendOrHold(message) {
      if (!sendReport(message)) unsentMessages.push(message);
      return true;
    },
    flushUnsent() {
      while (unsentMessages.length > 0) {
        const oldestMessage = unsentMessages[0];
        if (!oldestMessage || !sendReport(oldestMessage)) return;
        unsentMessages.shift();
      }
    },
  };
}

function createClientLogReporter(sendReport: SendReport): { report: (scope: string, text: string) => void; flushUnsent: () => void } {
  const holdingSender = createHoldingSender(sendReport);
  const sendLimitNotice = () => holdingSender.sendOrHold({ type: 'client-log', scope: 'client-log', text: `More than ${MAX_REPORTS_PER_PAGE} distinct log lines on this page; later ones were not sent.` });
  const sendOnce = createOncePerKeySender(holdingSender.sendOrHold, MAX_REPORTS_PER_PAGE, sendLimitNotice);
  return {
    report(scope, text) {
      const logLine = { scope: scope.slice(0, CLIENT_LOG_SCOPE_MAX_CHARS), text: text.slice(0, CLIENT_LOG_TEXT_MAX_CHARS) };
      sendOnce(`${logLine.scope}\n${logLine.text}`, { type: 'client-log', ...logLine });
    },
    flushUnsent: holdingSender.flushUnsent,
  };
}

function createHeaderErrorTelemetryReporter(sendReport: SendReport): { report: (source: string, message: string) => void; flushUnsent: () => void } {
  const holdingSender = createHoldingSender(sendReport);
  const limitNotice = { source: 'dashboard', message: `More than ${MAX_REPORTS_PER_PAGE} distinct header errors on this page; later ones were not sent.` };
  const sendLimitNotice = () => holdingSender.sendOrHold({ type: 'dashboard-telemetry', event: 'header_error_shown', properties: limitNotice });
  const sendOnce = createOncePerKeySender(holdingSender.sendOrHold, MAX_REPORTS_PER_PAGE, sendLimitNotice);
  return {
    report(source, message) {
      const properties = { source: source.slice(0, TELEMETRY_TEXT_MAX_CHARS), message: message.slice(0, TELEMETRY_TEXT_MAX_CHARS) };
      sendOnce(`${properties.source}\n${properties.message}`, { type: 'dashboard-telemetry', event: 'header_error_shown', properties });
    },
    flushUnsent: holdingSender.flushUnsent,
  };
}

export { createClientErrorReporter, createClientLogReporter, createHeaderErrorTelemetryReporter, describeFailure, describeSchemaIssues, frameTypeOf };
