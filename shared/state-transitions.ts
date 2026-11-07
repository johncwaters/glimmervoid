type TransitionTable<State extends string, Event extends string> = Readonly<Record<State, Readonly<Partial<Record<Event, State>>>>>;

export function defineTransitions<State extends string, Event extends string>(table: Record<State, Partial<Record<Event, State>>>): { next(from: State, event: Event): State | null } {
  for (const moves of Object.values<Partial<Record<Event, State>>>(table)) Object.freeze(moves);
  const frozenTable: TransitionTable<State, Event> = Object.freeze(table);
  return { next: (from, event) => frozenTable[from][event] ?? null };
}
