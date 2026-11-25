import test from 'node:test';

import { createBoardStore } from '../../server/whiteboard/board-store-client.ts';
import { createLayoutClient } from '../../server/whiteboard/layout-client.ts';
import { createWhiteboardWiring } from '../../server/whiteboard/whiteboard-wiring.ts';

const openClosables = new Set<{ close: () => Promise<void> }>();

function closedOnTestEnd<T extends { close: () => Promise<void> }>(closable: T): T {
  const close = closable.close;
  openClosables.add(closable);
  closable.close = () => {
    openClosables.delete(closable);
    return close();
  };
  return closable;
}

function openWhiteboardWiring(...options: Parameters<typeof createWhiteboardWiring>): ReturnType<typeof createWhiteboardWiring> {
  return closedOnTestEnd(createWhiteboardWiring(...options));
}

async function restartWhiteboardWiring(running: ReturnType<typeof createWhiteboardWiring>, ...options: Parameters<typeof createWhiteboardWiring>): Promise<ReturnType<typeof createWhiteboardWiring>> {
  await running.close();
  return openWhiteboardWiring(...options);
}

function openBoardStore(boardsRoot: string): ReturnType<typeof createBoardStore> {
  return closedOnTestEnd(createBoardStore(boardsRoot));
}

function openLayoutClient(...options: Parameters<typeof createLayoutClient>): ReturnType<typeof createLayoutClient> {
  return closedOnTestEnd(createLayoutClient(...options));
}

test.afterEach(async () => {
  await Promise.all([...openClosables].map((closable) => closable.close()));
});

export { openBoardStore, openLayoutClient, openWhiteboardWiring, restartWhiteboardWiring };
