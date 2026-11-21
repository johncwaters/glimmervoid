import { BOARD_PAGE_FEED_MESSAGE } from '#shared/contracts/whiteboard.ts';
import type { BoardPageFeed } from '#shared/contracts/whiteboard.ts';

let latestSessionFeed: BoardPageFeed = { type: BOARD_PAGE_FEED_MESSAGE, topic: 'sessions', sessions: [] };
const feedListeners = new Set<(feed: BoardPageFeed) => void>();

export function showBoardSessionFeed(sessions: BoardPageFeed['sessions']): void {
  if (JSON.stringify(sessions) === JSON.stringify(latestSessionFeed.sessions)) return;
  latestSessionFeed = { ...latestSessionFeed, sessions };
  for (const listener of feedListeners) listener(latestSessionFeed);
}

export function followBoardSessionFeed(listener: (feed: BoardPageFeed) => void): void {
  feedListeners.add(listener);
  listener(latestSessionFeed);
}
