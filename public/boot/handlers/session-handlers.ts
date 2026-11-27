import { setSessionWakes } from '../../session-card/session-wakes.ts';
import { alertFromNotify } from '../../notifications.ts';
import { requestSessionRemovalNow } from '../../session-actions.ts';
import { handleDebugStateRefresh, handleDebugStateResponse } from '../../session-card/card-debug.ts';
import { reportSessionProblem } from '../../session-card/card-problems.ts';
import type { DashboardHandlerTable } from '../core/message-dispatch-core.ts';

const messageHandlers = {
  'session-close-confirm': (msg) => { requestSessionRemovalNow(msg.id); },
  'session-wakes': (msg) => setSessionWakes(msg.id, msg.wakes),
  'debug-state-response': (msg) => handleDebugStateResponse(msg),
  'notify': (msg) => { alertFromNotify(msg); handleDebugStateRefresh(msg.session); },
  'session-error': (msg) => {
    reportSessionProblem(msg.id, msg.message);
  },
} satisfies DashboardHandlerTable;

export { messageHandlers as sessionHandlers };
