const COHERENCE_CONFIG_FILENAME = 'coherence.config.json';
const COHERENCE_CONFIG_MAX_BYTES = 256 * 1024;
const BUILTIN_LANGUAGE_NAME = /^[a-z0-9-]+$/;

type CoherenceConfigEntry =
  | { kind: 'missing' }
  | { kind: 'symlink' }
  | { kind: 'not-a-file' }
  | { kind: 'too-large' }
  | { kind: 'file'; text: string };

type CoherenceConfigVerdict = { ok: true } | { ok: false; reason: string };

interface ConfigFileStat {
  isSymbolicLink: () => boolean;
  isFile: () => boolean;
  size: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unreadableConfigEntry(entry: ConfigFileStat | null): Exclude<CoherenceConfigEntry, { kind: 'file' }> | null {
  if (!entry) return { kind: 'missing' };
  if (entry.isSymbolicLink()) return { kind: 'symlink' };
  if (!entry.isFile()) return { kind: 'not-a-file' };
  if (entry.size > COHERENCE_CONFIG_MAX_BYTES) return { kind: 'too-large' };
  return null;
}

function judgeCoherenceConfig(entry: CoherenceConfigEntry): CoherenceConfigVerdict {
  if (entry.kind === 'missing') return { ok: false, reason: `the checkout has no ${COHERENCE_CONFIG_FILENAME}` };
  if (entry.kind === 'symlink') return { ok: false, reason: `${COHERENCE_CONFIG_FILENAME} is a symlink` };
  if (entry.kind === 'not-a-file') return { ok: false, reason: `${COHERENCE_CONFIG_FILENAME} is not a regular file` };
  if (entry.kind === 'too-large') return { ok: false, reason: `${COHERENCE_CONFIG_FILENAME} is larger than ${COHERENCE_CONFIG_MAX_BYTES} bytes` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.text);
  } catch {
    return { ok: false, reason: `${COHERENCE_CONFIG_FILENAME} is not valid JSON` };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: `${COHERENCE_CONFIG_FILENAME} is not a JSON object` };
  const language = parsed.language;
  if (language === undefined) return { ok: true };
  if (typeof language === 'string' && BUILTIN_LANGUAGE_NAME.test(language)) return { ok: true };
  return { ok: false, reason: `${COHERENCE_CONFIG_FILENAME} names a language module instead of a built-in language` };
}

export { COHERENCE_CONFIG_FILENAME, judgeCoherenceConfig, unreadableConfigEntry };
export type { CoherenceConfigEntry };
