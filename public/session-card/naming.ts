import { sessionUIs } from './card-registry.ts';
import { nextSuggestedName } from '#shared/session-naming.ts';

function currentSessionNames() {
  const names: string[] = [];
  for (const [, ui] of sessionUIs) names.push(ui.card.dataset.session ?? '');
  return names;
}

export function suggestSessionName(baseName: string | null | undefined) {
  return nextSuggestedName(baseName ?? '', currentSessionNames());
}
