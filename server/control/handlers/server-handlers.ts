import os from 'node:os';
import type { ClientMessageOf } from '../../../shared/contracts/index.ts';
import { CLIENT_LOG_SCOPE_MAX_CHARS, CLIENT_LOG_TEXT_MAX_CHARS } from '../../../shared/contracts/control-messages.ts';
import { DashboardTelemetryReport } from '../../../shared/contracts/telemetry.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';
import type { ControlHandlerDeps } from '../../control-handlers.ts';
import { sanitizeOneLine, showHomeAsTilde } from '../../core/text-core.ts';
import type { ControlContext } from '../control-context.ts';
import { sendError } from '../control-context.ts';
import type { ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable } from '../core/control-dispatch-core.ts';

function createServerHandlers(_context: ControlContext, deps: ControlHandlerDeps): ControlHandlerGroup {
  const {
    broadcastControl,
    requestShutdown,
    requestRestart,
    acknowledgeSeenAlert,
    buildHealthSnapshot,
    getUpdateStatus,
    getUpdateJournal = null,
    getPostTurnLeftoversNotice = null,
    recheckPostTurnLeftovers = null,
    featureHints = null,
    checkNow = null,
    applyUpdate = null,
    noteRestartRequested = null,
  } = deps;

  function handlePing(msg: ClientMessageOf<'ping'>, ws: ControlSocket): void {
    if (!msg.requestId) return;
    ws.send(JSON.stringify({ type: 'pong', requestId: msg.requestId }));
  }

  function noteFeatureHintReport(report: DashboardTelemetryReport): void {
    if (!featureHints) return;
    if (report.event === 'view_shown') {
      void featureHints.noteViewShown(report.properties.view);
      return;
    }
    if (report.event !== 'operator_action' || report.properties.surface !== 'hints' || !report.properties.feature) return;
    if (report.properties.action === 'open') void featureHints.settle(report.properties.feature, 'opened');
    if (report.properties.action === 'dismiss') void featureHints.settle(report.properties.feature, 'dismissed');
  }

  function captureDashboardTelemetry(msg: ClientMessageOf<'dashboard-telemetry'>): void {
    const report = DashboardTelemetryReport.safeParse(msg);
    if (!report.success) return;
    noteFeatureHintReport(report.data);
    if (report.data.event === 'header_error_shown') {
      const { source, message } = report.data.properties;
      deps.telemetry?.capture?.('header_error_shown', { source, message: showHomeAsTilde(message, os.homedir()) });
      return;
    }
    deps.telemetry?.capture?.(report.data.event, report.data.properties);
  }

  function handleShutdown(): void {
    console.log('[control] Shutdown requested via UI');
    broadcastControl({ type: 'shutting-down' });
    setTimeout(() => {
      if (requestShutdown) requestShutdown();
    }, 200);
  }

  async function handleUpdateCheck(_msg: ClientMessageOf<'update-check'>, ws: ControlSocket): Promise<void> {
    if (!checkNow) {
      sendError(ws, '[update-check-unavailable] Update checking is unavailable.', { scope: 'update' });
      return;
    }
    await checkNow();
  }

  async function handleUpdateApply(_msg: ClientMessageOf<'update-apply'>, ws: ControlSocket): Promise<void> {
    if (!applyUpdate) {
      sendError(ws, '[update-apply-unavailable] Update application is unavailable.', { scope: 'update' });
      return;
    }
    const outcome = await applyUpdate();
    if (outcome.ok) return;
    sendError(ws, `[${outcome.reason || 'update-refused'}] ${outcome.message}`, { scope: 'update' });
  }

  function handleRestart(_msg: ClientMessageOf<'restart-server'>): void {
    noteRestartRequested?.();
    console.log('[control] Restart requested via UI');
    broadcastControl({ type: 'restarting' });
    setTimeout(() => {
      if (requestRestart) requestRestart();
    }, 200);
  }

  function connectFrames(): readonly unknown[] {
    const frames: unknown[] = [];
    if (buildHealthSnapshot) frames.push({ type: 'health-snapshot', stats: buildHealthSnapshot() });
    const update = typeof getUpdateStatus === 'function' ? getUpdateStatus() : null;
    if (update) frames.push({ type: 'update-status', ...update });
    const updateJournal = typeof getUpdateJournal === 'function' ? getUpdateJournal() : null;
    if (updateJournal) frames.push({ type: 'update-progress', journal: updateJournal });
    const postTurnLeftoversNotice = getPostTurnLeftoversNotice?.() ?? null;
    if (postTurnLeftoversNotice) frames.push(postTurnLeftoversNotice);
    const featureHintMessage = featureHints?.pendingHintMessage() ?? null;
    if (featureHintMessage) frames.push(featureHintMessage);
    return frames;
  }

  function afterConnect(): void {
    recheckPostTurnLeftovers?.();
  }

  const handlers = {
    'ping': handlePing,
    'shutdown': handleShutdown,
    'restart-server': handleRestart,
    'update-check': handleUpdateCheck,
    'update-apply': handleUpdateApply,
    'alert-seen': (msg: ClientMessageOf<'alert-seen'>) => { if (acknowledgeSeenAlert) acknowledgeSeenAlert(msg.id); },
    'client-error': (msg: ClientMessageOf<'client-error'>) => {
      if (typeof msg.name !== 'string' || typeof msg.stack !== 'string') return;
      deps.telemetry?.captureClientError({ name: msg.name, stack: msg.stack });
    },
    'client-log': (msg: ClientMessageOf<'client-log'>) => {
      console.warn(`[dashboard] ${sanitizeOneLine(msg.scope, CLIENT_LOG_SCOPE_MAX_CHARS)}: ${sanitizeOneLine(msg.text, CLIENT_LOG_TEXT_MAX_CHARS)}`);
    },
    'dashboard-telemetry': captureDashboardTelemetry,
    'request-telemetry-deletion': async (msg: ClientMessageOf<'request-telemetry-deletion'>, ws: ControlSocket) => {
      const ok = await deps.telemetry?.requestDataDeletion?.() ?? false;
      ws.send(JSON.stringify({ type: 'telemetry-deletion-result', requestId: msg.requestId || null, ok }));
    },
    'request-health-snapshot': (_msg: ClientMessageOf<'request-health-snapshot'>, ws: ControlSocket) => {
      if (!buildHealthSnapshot) return;
      ws.send(JSON.stringify({ type: 'health-snapshot', stats: buildHealthSnapshot() }));
    },
  } satisfies ControlHandlerTable;

  const invalidReplies = {
    'ping': (_msg, requestId, message) => ({ type: 'pong', requestId, error: message }),
  } satisfies InvalidReplyTable;

  return { handlers, invalidReplies, genericErrorTypes: ['request-health-snapshot'], connectFrames, afterConnect };
}

export { createServerHandlers };
