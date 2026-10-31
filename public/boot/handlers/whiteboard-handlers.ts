import { applyWhiteboardPatch, applyWhiteboardRemoved, applyWhiteboardsSnapshot } from '../../whiteboard/board-store.ts';
import type { DashboardHandlerTable } from '../core/message-dispatch-core.ts';

const messageHandlers = {
  'whiteboards-snapshot': (msg) => applyWhiteboardsSnapshot(msg),
  'whiteboard-patch': (msg) => applyWhiteboardPatch(msg),
  'whiteboard-removed': (msg) => applyWhiteboardRemoved(msg),
} satisfies DashboardHandlerTable;

export { messageHandlers as whiteboardHandlers };
