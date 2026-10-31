import type { ServerMessage, ServerMessageOf } from '#shared/contracts/control-messages.ts';

type DashboardHandlerTable = { [Type in ServerMessage['type']]?: (message: ServerMessageOf<Type>) => void };

function mergeMessageHandlerGroups(groups: readonly DashboardHandlerTable[]): DashboardHandlerTable {
  const merged: DashboardHandlerTable = {};
  for (const group of groups) {
    for (const type of Object.keys(group)) {
      if (Object.hasOwn(merged, type)) throw new Error(`dashboard message type ${type} is claimed by two handler groups`);
    }
    Object.assign(merged, group);
  }
  return merged;
}

export { mergeMessageHandlerGroups };
export type { DashboardHandlerTable };
