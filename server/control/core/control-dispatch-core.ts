import type { ClientMessage, ClientMessageOf } from '../../../shared/contracts/index.ts';
import type { ControlSocket } from '../../backend/backend-websockets.ts';

type ControlHandler<Type extends ClientMessage['type']> = (msg: ClientMessageOf<Type>, ws: ControlSocket) => unknown;
type ControlHandlerTable = { [Type in ClientMessage['type']]?: ControlHandler<Type> };
type RawControlRequest = Record<string, unknown> | null | undefined;
type InvalidReplyBuilder = (msg: RawControlRequest, requestId: string | null, message: string) => Record<string, unknown>;
type InvalidReplyTable = Partial<Record<ClientMessage['type'], InvalidReplyBuilder>>;
type ConnectFrames = () => readonly unknown[];

interface ControlHandlerGroup {
  handlers: ControlHandlerTable;
  invalidReplies?: InvalidReplyTable;
  genericErrorTypes?: readonly ClientMessage['type'][];
  connectFrames?: ConnectFrames;
  afterConnect?: () => void;
}

type ConnectStep = Pick<ControlHandlerGroup, 'connectFrames' | 'afterConnect'>;

interface MergedControlGroups {
  handlers: ControlHandlerTable;
  invalidReplies: Readonly<Record<string, InvalidReplyBuilder>>;
  genericErrorTypes: ReadonlySet<string>;
  connectSteps: readonly ConnectStep[];
}

const UNREADABLE_REQUEST_TEXT = 'The server could not read a request from this page, most likely because the page is older than the server. Reload the page.';

function mergeHandlerGroups(groups: readonly ControlHandlerGroup[]): MergedControlGroups {
  const handlers: ControlHandlerTable = {};
  const invalidReplies: Record<string, InvalidReplyBuilder> = {};
  const genericErrorTypes = new Set<string>();
  const connectSteps: ConnectStep[] = [];
  for (const group of groups) {
    for (const type of Object.keys(group.handlers)) {
      if (Object.hasOwn(handlers, type)) throw new Error(`control message type ${type} is claimed by two handler groups`);
    }
    Object.assign(handlers, group.handlers);
    Object.assign(invalidReplies, group.invalidReplies ?? {});
    for (const type of group.genericErrorTypes ?? []) genericErrorTypes.add(type);
    if (group.connectFrames || group.afterConnect) connectSteps.push({ connectFrames: group.connectFrames, afterConnect: group.afterConnect });
  }
  return { handlers, invalidReplies, genericErrorTypes, connectSteps };
}

function validationErrorReply(merged: MergedControlGroups, msg: RawControlRequest, message: string): Record<string, unknown> | null {
  const requestType = typeof msg?.type === 'string' ? msg.type : '';
  const requestId = typeof msg?.requestId === 'string' ? msg.requestId : null;
  if (Object.hasOwn(merged.invalidReplies, requestType)) return merged.invalidReplies[requestType](msg, requestId, message);
  if (merged.genericErrorTypes.has(requestType)) return { type: 'error', message: UNREADABLE_REQUEST_TEXT };
  return null;
}

export { mergeHandlerGroups, validationErrorReply };
export type { ConnectFrames, ControlHandlerGroup, ControlHandlerTable, InvalidReplyTable, RawControlRequest };
