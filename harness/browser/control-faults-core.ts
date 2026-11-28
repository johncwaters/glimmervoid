import { SERVER_MESSAGE_CLASS } from '../../shared/contracts/control/message-classes.ts';

export interface ControlFaultDelayConfig {
  replyDelayMs: number;
  pushDelayMs: number;
}

function isCollectionPushType(frameType: string): boolean {
  if (!Object.hasOwn(SERVER_MESSAGE_CLASS, frameType)) return false;
  return SERVER_MESSAGE_CLASS[frameType as keyof typeof SERVER_MESSAGE_CLASS] === 'collection';
}

export function controlServerFrameDelayMs(
  frame: Record<string, unknown> | null,
  config: ControlFaultDelayConfig,
): number {
  const frameType = typeof frame?.type === 'string' ? frame.type : null;
  if (frameType === 'pong') return 0;
  const hasRequestId = typeof frame?.requestId === 'string';
  const isCollectionPush = frameType !== null && isCollectionPushType(frameType);
  const hasSeq = typeof frame?.seq === 'number';
  if ((isCollectionPush || (hasSeq && !hasRequestId)) && config.pushDelayMs > 0) {
    return config.pushDelayMs;
  }
  if (hasRequestId && !isCollectionPush && config.replyDelayMs > 0) {
    return config.replyDelayMs;
  }
  return 0;
}
