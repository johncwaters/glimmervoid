import './tailwind.css';

import { describeFailure } from './client-error-core.ts';
import { isSessionJournalReadable, openCoherenceJournal, sessionRowCoherenceSignals } from './coherence/journal-drawer.ts';
import { superviseConnection } from './connection-supervisor.ts';
import { connectControl, reportToServerLog, sendControlMsg } from './control-ws.ts';
import { queryTag } from './dom-helpers.ts';
import { routeExternalAnchorsThroughHost } from './external-link.ts';
import { applyFlyingAnimals } from './flying-animals.ts';
import { initFormFactor } from './form-factor.ts';
import { paintSessionPrRows, sessionRowPrSignals } from './github/session-pr-chips.ts';
import { mountHealthMonitor } from './health-monitor.ts';
import { setHooksRequestSender } from './hooks-store.ts';
import { whenBundledMonoFontLoads } from './mono-font.ts';
import { setCardCoherenceJournal, setCardConnectBoard, setCardSessionSetup, setLinkedPrsPainter } from './session-card/card-dom.ts';
import { setAccountSignIn } from './session-card/card-account.ts';
import { openAgentAccountDialog } from './dialogs.ts';
import { connectableAgentOf } from './agent-logins.ts';
import { refreshTerminalFonts } from './session-card/lifecycle.ts';
import { prewarmDataSocket } from './session-card/terminal-data-socket.ts';
import { addSessionRowSignalSource } from './session-row.ts';
import { openSessionSetup } from './session-setup/setup-dialog.ts';
import { onStreamerModeChanged } from './streamer-mode.ts';
import { applyTheme, onUnicornThemeEntered } from './theme.ts';
import { setTraceRequestSender } from './trace-store.ts';
import { getLastFocusedSessionId, getThemeId, isFlyingAnimalsEnabled } from './ui-prefs.ts';
import { setUsageRequestSender } from './usage/usage-store.ts';
import { openConnectBoardDialog, sessionRowBoardSignals, setBoardsViewOpener } from './whiteboard/board-chips.ts';
import { loadPageToken } from './ws-token.ts';

import { wireViewerFocus } from './boot/viewer-focus.ts';
import { mountViewTabs, openBoardsSurface, openView, refreshViewsIfVisible } from './boot/view-tabs.ts';
import { wireHashRouting } from './boot/hash-routes.ts';
import { mountHeaderControls, mountHeaderTrays } from './boot/header-controls.ts';
import { mountTelemetryBanner } from './boot/banners.ts';
import { mountConnectionScreen, scheduleServerUnreachableHint } from './boot/connection-screen.ts';
import { wireStatusPainters } from './boot/session-frames.ts';
import { wireMessageDispatch } from './boot/message-dispatch.ts';
import { mountLayoutSwitch } from './boot/layout-switch.ts';
import { wireDashboardShortcuts } from './boot/shortcuts-dispatch.ts';
import { wireClientErrorReporting } from './boot/client-errors.ts';
import { holdDashboardTabLock } from './boot/dashboard-tab-lock.ts';

applyTheme(getThemeId());
onUnicornThemeEntered(() => {
  void import('./alert-sound.ts').then(
    (alertSound) => alertSound.playNyanJingle(),
    (error: unknown) => reportToServerLog('alert-sound', `nyan jingle failed to load: ${describeFailure(error)}`),
  );
});
applyFlyingAnimals(isFlyingAnimalsEnabled());

initFormFactor();
holdDashboardTabLock();
routeExternalAnchorsThroughHost(document);

mountConnectionScreen();

wireStatusPainters();

setUsageRequestSender(sendControlMsg);
void import('./your-day-tip.ts').then(
  (yourDayTip) => yourDayTip.startYourDayTips({ openUsage: () => openView('usage') }),
  (error: unknown) => reportToServerLog('your-day-tip', `your day tips failed to load: ${describeFailure(error)}`),
);
setHooksRequestSender(sendControlMsg);
setTraceRequestSender(sendControlMsg);
setLinkedPrsPainter(paintSessionPrRows);
addSessionRowSignalSource(sessionRowCoherenceSignals);
addSessionRowSignalSource(sessionRowPrSignals, 'links');
addSessionRowSignalSource(sessionRowBoardSignals, 'links');
setCardConnectBoard(openConnectBoardDialog);
setBoardsViewOpener(openBoardsSurface);
setCardCoherenceJournal({ isReadable: isSessionJournalReadable, open: openCoherenceJournal });
setCardSessionSetup(openSessionSetup);
setAccountSignIn((agentId, accountId) => {
  const agent = connectableAgentOf(agentId);
  if (!agent) return;
  openAgentAccountDialog(agent, accountId);
});

onStreamerModeChanged(() => refreshViewsIfVisible('settings-updated'));

wireMessageDispatch();

mountTelemetryBanner();

mountHeaderControls();

wireHashRouting();

mountHeaderTrays();

mountViewTabs();

mountLayoutSwitch();


wireDashboardShortcuts();

wireViewerFocus();
wireClientErrorReporting();

mountHealthMonitor(queryTag(document, '#health-footer-mount', 'div'));

whenBundledMonoFontLoads(refreshTerminalFonts);

scheduleServerUnreachableHint();
superviseConnection();
connectControl();

const restorableSessionId = getLastFocusedSessionId();
if (restorableSessionId) void loadPageToken().then(() => prewarmDataSocket(restorableSessionId));
