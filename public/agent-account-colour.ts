const MACHINE_LOGIN_COLOUR = 'var(--accent)';

const ACCOUNT_COLOURS: readonly string[] = Object.freeze([
  'var(--state-complete)',
  'var(--state-monitoring)',
  'var(--state-waiting)',
  'var(--state-starting)',
  'var(--state-done)',
  'var(--state-idle)',
]);

function hashOf(text: string): number {
  let hash = 0;
  for (const character of text) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash;
}

export function accountColourOf(accountId: string | null): string {
  if (accountId === null) return MACHINE_LOGIN_COLOUR;
  return ACCOUNT_COLOURS[hashOf(accountId) % ACCOUNT_COLOURS.length];
}
