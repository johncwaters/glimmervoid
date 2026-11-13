const NO_PATH_KEY = '(no path)';

export interface RosterGroup<Row> {
  key: string;
  label: string;
  title: string;
  projectPath: string | null;
  rows: Row[];
}

interface GroupedRoster<Row> {
  flat: boolean;
  order: string[];
  groups: RosterGroup<Row>[];
}

export function basename(p: unknown): string {
  if (!p) return NO_PATH_KEY;
  const s = String(p).replace(/[/\\]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const tail = i === -1 ? s : s.slice(i + 1);
  return tail || NO_PATH_KEY;
}

export function groupRoster<Row extends { id: string }>(
  orderedRows: readonly Row[] | null | undefined,
  pathOf: (row: Row) => unknown,
  namedGroupOf: (row: Row) => { key: string; label: string; title: string } | null = () => null,
): GroupedRoster<Row> {
  const rows = Array.isArray(orderedRows) ? orderedRows : [];
  const byKey = new Map<string, RosterGroup<Row>>();
  for (const row of rows) {
    const namedGroup = namedGroupOf(row);
    const raw = pathOf(row);
    const key = namedGroup?.key ?? (raw ? String(raw) : NO_PATH_KEY);
    let g = byKey.get(key);
    if (!g) {
      g = namedGroup
        ? { ...namedGroup, key, projectPath: null, rows: [] }
        : { key, label: key === NO_PATH_KEY ? NO_PATH_KEY : basename(key), title: key, projectPath: key === NO_PATH_KEY ? null : key, rows: [] };
      byKey.set(key, g);
    }
    g.rows.push(row);
  }
  return sortedRoster([...byKey.values()]);
}

function sortedRoster<Row>(groups: RosterGroup<Row>[]): GroupedRoster<Row> {
  groups.sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' })
    || a.key.localeCompare(b.key));
  return { flat: groups.length <= 1, order: groups.map((g) => g.key), groups };
}

export function withBoardProjects<Row>(roster: GroupedRoster<Row>, boardProjectKeys: Iterable<string>): GroupedRoster<Row> {
  const presentKeys = new Set(roster.order);
  const missingKeys = [...new Set(boardProjectKeys)].filter((key) => !presentKeys.has(key));
  if (missingKeys.length === 0) return roster;
  const boardOnlyGroups = missingKeys.map((key): RosterGroup<Row> => ({
    key,
    label: key === NO_PATH_KEY ? NO_PATH_KEY : basename(key),
    title: key,
    projectPath: key === NO_PATH_KEY ? null : key,
    rows: [],
  }));
  return sortedRoster([...roster.groups, ...boardOnlyGroups]);
}

export function visibleOrder<Row extends { id: string }>(
  groups: GroupedRoster<Row> | null | undefined,
  collapsedSet?: ReadonlySet<string> | null,
  viewedId: string | null = null,
): string[] {
  if (!groups || !Array.isArray(groups.groups)) return [];
  const collapsed = collapsedSet || new Set<string>();
  const ids: string[] = [];

  if (groups.flat) {
    for (const g of groups.groups) for (const row of g.rows) ids.push(row.id);
    return ids;
  }
  const byKey = new Map(groups.groups.map((g) => [g.key, g]));
  for (const key of groups.order) {
    const g = byKey.get(key);
    if (!g) continue;
    const isFolded = collapsed.has(key);
    for (const row of g.rows) {
      if (isFolded && row.id !== viewedId) continue;
      ids.push(row.id);
    }
  }
  return ids;
}

interface RailBoard {
  id: string;
  title: string;
  project: string | null;
  isArchived: boolean;
  connectedSessionIds: readonly string[];
}

export type SplitBoardBySession = Readonly<Record<string, string>>;

const byTitle = (left: RailBoard, right: RailBoard) => left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: 'base' }) || left.id.localeCompare(right.id);

export function parseSplitBoardBySession(stored: unknown): SplitBoardBySession {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const sessionIdByBoardId = new Map<string, string>();
  for (const [sessionId, boardId] of Object.entries(stored)) {
    if (typeof boardId === 'string' && boardId) sessionIdByBoardId.set(boardId, sessionId);
  }
  return Object.fromEntries([...sessionIdByBoardId].map(([boardId, sessionId]) => [sessionId, boardId]));
}

export function splitsOfBoards(splits: SplitBoardBySession, boards: readonly RailBoard[]): SplitBoardBySession {
  const boardIds = new Set(boards.map((board) => board.id));
  const entries = Object.entries(splits);
  const keptEntries = entries.filter(([, boardId]) => boardIds.has(boardId));
  return keptEntries.length === entries.length ? splits : Object.fromEntries(keptEntries);
}

export function openSplit(splits: SplitBoardBySession, sessionId: string, boardId: string): SplitBoardBySession {
  const otherSplits = Object.entries(splits).filter(([splitSessionId, splitBoardId]) => splitSessionId !== sessionId && splitBoardId !== boardId);
  return Object.fromEntries([...otherSplits, [sessionId, boardId]]);
}

export function closeSplit(splits: SplitBoardBySession, sessionId: string): SplitBoardBySession {
  if (!Object.hasOwn(splits, sessionId)) return splits;
  return Object.fromEntries(Object.entries(splits).filter(([splitSessionId]) => splitSessionId !== sessionId));
}

export function liveSplits(splits: SplitBoardBySession, boards: readonly RailBoard[], isLiveSession: (sessionId: string) => boolean): SplitBoardBySession {
  const splitsOfExistingBoards = splitsOfBoards(splits, boards);
  const entries = Object.entries(splitsOfExistingBoards);
  const liveEntries = entries.filter(([sessionId]) => isLiveSession(sessionId));
  return liveEntries.length === entries.length ? splitsOfExistingBoards : Object.fromEntries(liveEntries);
}

export function liveShellSplits(splits: SplitBoardBySession, isLiveSession: (sessionId: string) => boolean): SplitBoardBySession {
  const entries = Object.entries(splits);
  const liveEntries = entries.filter(([sessionId, shellId]) => isLiveSession(sessionId) && isLiveSession(shellId));
  return liveEntries.length === entries.length ? splits : Object.fromEntries(liveEntries);
}

const connectionKeyOf = (boardId: string, sessionId: string) => `${boardId}\n${sessionId}`;

export function connectionKeysOf(boards: readonly RailBoard[]): Set<string> {
  return new Set(boards.flatMap((board) => board.connectedSessionIds.map((sessionId) => connectionKeyOf(board.id, sessionId))));
}

export function splitNewConnections(splits: SplitBoardBySession, boardsNewestFirst: readonly RailBoard[], previousConnectionKeys: ReadonlySet<string>, isLiveSession: (sessionId: string) => boolean): SplitBoardBySession {
  return boardsNewestFirst.reduce((nextSplits, board) => board.connectedSessionIds.reduce((splitsSoFar, sessionId) => {
    if (previousConnectionKeys.has(connectionKeyOf(board.id, sessionId))) return splitsSoFar;
    const shownSplits = liveSplits(splitsSoFar, boardsNewestFirst, isLiveSession);
    const isSessionFree = !Object.hasOwn(shownSplits, sessionId);
    const isBoardFree = !Object.values(shownSplits).includes(board.id);
    return isSessionFree && isBoardFree ? openSplit(splitsSoFar, sessionId, board.id) : splitsSoFar;
  }, nextSplits), splits);
}

export function newestFreeBoardOf(splits: SplitBoardBySession, connectedBoardsNewestFirst: readonly RailBoard[]): RailBoard | null {
  const splitBoardIds = new Set(Object.values(splits));
  return connectedBoardsNewestFirst.find((board) => !splitBoardIds.has(board.id)) ?? null;
}

export interface ProjectBoards<Board> {
  active: Board[];
  archived: Board[];
}

function projectKeyOf(board: Pick<RailBoard, 'project'>): string {
  return board.project ?? NO_PATH_KEY;
}

export function boardsByProject<Board extends RailBoard>(boards: readonly Board[], splits: SplitBoardBySession, groupKeyBySessionId: ReadonlyMap<string, string>): Map<string, ProjectBoards<Board>> {
  const splitBoardIds = new Set(Object.values(splits));
  const byProject = new Map<string, ProjectBoards<Board>>();
  for (const board of [...boards].sort(byTitle)) {
    if (splitBoardIds.has(board.id)) continue;
    const key = projectKeyOf(board);
    if (board.connectedSessionIds.some((sessionId) => groupKeyBySessionId.get(sessionId) === key)) continue;
    const projectBoards = byProject.get(key) ?? { active: [], archived: [] };
    (board.isArchived ? projectBoards.archived : projectBoards.active).push(board);
    byProject.set(key, projectBoards);
  }
  return byProject;
}
