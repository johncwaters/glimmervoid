const NO_PATH_KEY = '(no path)';

export interface RosterGroup<Row> {
  key: string;
  label: string;
  title: string;
  projectPath: string | null;
  hostId: string | null;
  hostName: string | null;
  rows: Row[];
}

interface RosterHost {
  id: string;
  name: string;
  rank: number;
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
  hostOf: (row: Row) => RosterHost | null = () => null,
): GroupedRoster<Row> {
  const rows = Array.isArray(orderedRows) ? orderedRows : [];
  const byKey = new Map<string, RosterGroup<Row>>();
  const hostRankByKey = new Map<string, number>();
  for (const row of rows) {
    const namedGroup = namedGroupOf(row);
    const host = hostOf(row);
    const raw = pathOf(row);
    const baseKey = namedGroup?.key ?? (raw ? String(raw) : NO_PATH_KEY);
    const key = host ? `${host.id}\n${baseKey}` : baseKey;
    let g = byKey.get(key);
    if (!g) {
      const hostFields = { hostId: host?.id ?? null, hostName: host?.name ?? null };
      g = namedGroup
        ? { ...namedGroup, key, projectPath: null, ...hostFields, rows: [] }
        : { key, label: baseKey === NO_PATH_KEY ? NO_PATH_KEY : basename(baseKey), title: baseKey, projectPath: baseKey === NO_PATH_KEY || host ? null : baseKey, ...hostFields, rows: [] };
      byKey.set(key, g);
      hostRankByKey.set(key, host ? host.rank : -1);
    }
    g.rows.push(row);
  }
  const groups = [...byKey.values()];

  groups.sort((a, b) =>
    (hostRankByKey.get(a.key) ?? -1) - (hostRankByKey.get(b.key) ?? -1)
    || a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' })
    || a.key.localeCompare(b.key));
  const isAllLocal = groups.every((group) => group.hostId === null);
  return { flat: byKey.size <= 1 && isAllLocal, order: groups.map((g) => g.key), groups };
}

export function visibleOrder<Row extends { id: string }>(
  groups: GroupedRoster<Row> | null | undefined,
  collapsedSet?: ReadonlySet<string> | null,
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
    if (collapsed.has(key)) continue;
    const g = byKey.get(key);
    if (g) for (const row of g.rows) ids.push(row.id);
  }
  return ids;
}

interface RailBoard {
  id: string;
  title: string;
  connectedSessionIds: readonly string[];
}

export function sessionlessBoards<Board extends RailBoard>(boards: readonly Board[], isLiveSession: (sessionId: string) => boolean): Board[] {
  return boards
    .filter((board) => !board.connectedSessionIds.some(isLiveSession))
    .sort((left, right) => left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: 'base' }) || left.id.localeCompare(right.id));
}
