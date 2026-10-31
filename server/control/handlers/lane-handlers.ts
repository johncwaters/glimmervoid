import { configIssueMessage } from '../../../shared/contracts/index.ts';
import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import { BenchmarkActionRequest } from '../../../shared/contracts/benchmark.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import type { ControlContext } from '../control-context.ts';
import { replyTo } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';

const USAGE_REPORT_MAX_DAYS = 3650;

function createLaneHandlers(_context: ControlContext, deps: ControlHandlerDeps): ControlHandlerGroup {
  const {
    getBenchmarkStatus = null,
    benchmarks = null,
    getUsageSessions = null,
    getUsageReport = null,
    requestUsageReport = null,
    getPlanLimits = null,
  } = deps;

  async function handleBenchmarkAction(msg: ClientMessageOf<'benchmark-action'>, ws: ControlSocket): Promise<void> {
    const parsed = BenchmarkActionRequest.safeParse(msg);
    if (!parsed.success) {
      replyTo(ws, msg, 'benchmark-action-result', { suiteId: String(msg.suiteId ?? ''), action: msg.action, ok: false, error: configIssueMessage(parsed.error) });
      return;
    }
    if (!benchmarks) {
      replyTo(ws, msg, 'benchmark-action-result', { ...parsed.data, ok: false, error: 'Benchmarks are not running' });
      return;
    }
    replyTo(ws, msg, 'benchmark-action-result', await benchmarks.submitAction(parsed.data));
  }

  async function handleRequestUsageReport(msg: ClientMessageOf<'request-usage-report'>, ws: ControlSocket): Promise<void> {
    if (!requestUsageReport) {
      ws.send(JSON.stringify({ type: 'usage-report', requestId: msg.requestId || null, error: 'Usage tracking is not running' }));
      return;
    }
    const requestedDays = typeof msg.days === 'number' ? msg.days : Number.NaN;
    const days = Number.isInteger(requestedDays) && requestedDays > 0 && requestedDays <= USAGE_REPORT_MAX_DAYS ? requestedDays : undefined;
    const report = await requestUsageReport({ days, force: msg.force === true, requestId: msg.requestId || null });
    ws.send(JSON.stringify(report));
  }

  function connectFrames(): readonly unknown[] {
    const frames: unknown[] = [];
    const benchmarkStatus = typeof getBenchmarkStatus === 'function' ? getBenchmarkStatus() : null;
    if (benchmarkStatus) frames.push(benchmarkStatus);
    const usageSessions = typeof getUsageSessions === 'function' ? getUsageSessions() : null;
    if (usageSessions) frames.push(usageSessions);
    const usageReport = typeof getUsageReport === 'function' ? getUsageReport() : null;
    if (usageReport) frames.push(usageReport);
    const planLimitsMessages = typeof getPlanLimits === 'function' ? getPlanLimits() : [];
    for (const planLimits of planLimitsMessages) {
      if (planLimits) frames.push(planLimits);
    }
    return frames;
  }

  const handlers = {
    'benchmark-action': handleBenchmarkAction,
    'request-usage-report': handleRequestUsageReport,
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'benchmark-action': (msg, requestId, message) => ({ type: 'benchmark-action-result', requestId, suiteId: typeof msg?.suiteId === 'string' ? msg.suiteId : '', action: typeof msg?.action === 'string' ? msg.action : 'run', ok: false, error: message }),
    'request-usage-report': (_msg, requestId, message) => ({ type: 'usage-report', requestId, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies, connectFrames };
}

export { createLaneHandlers };
