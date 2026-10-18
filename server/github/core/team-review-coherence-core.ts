const COHERENCE_CONFIG_FILENAME = 'coherence.config.json';
const COHERENCE_CONFIG_MAX_BYTES = 256 * 1024;
const BUILTIN_LANGUAGE_NAME = /^[a-z0-9-]+$/;
const TRACKED_SYMLINK_MODE = '120000 ';
const SECTION_MAX_CHARS = 1500;
const MAX_LISTED_PAIRS = 5;
const REDUNDANCY_REPORTING_FLOOR = 3.5;
const UNTRUSTED_FIELD_MAX_CHARS = 120;
const REDUNDANCY_HEADER = /^\s*REDUNDANCY\b/m;
const REDUNDANCY_PAIR_START = /^\s+\d+\. score (\d+(?:\.\d+)?)\s/;
const REDUNDANCY_SITE = /^\s+([AB]) {2}(.+):\d+ {2}([a-z][a-z-]*) `([^`]*)`\s*$/;
const MARKDOWN_ACTIVE_CHARACTERS = /[`[\]()\n]/;
const REDUNDANCY_DIVERGED = /^\s+\S+ only in [AB]: /;
const SIGNAL_HEADER = /^CHANGE SIGNAL\b/m;
const SIGNAL_CLEAN = /clean working tree; nothing to assess/;
const SIGNAL_CHANGED_FILES = /(\d+) changed file\(s\)/;
const SIGNAL_SURFACE = /surface \+(\d+) exports \/ \+(\d+) variants \/ \+(\d+) LOC/;
const SIGNAL_ANCHORS = /anchors \+(\d+)/;
const SIGNAL_COMPONENTS = /components \+(\d+)/;

type CoherenceConfigEntry =
  | { kind: 'missing' }
  | { kind: 'symlink' }
  | { kind: 'not-a-file' }
  | { kind: 'too-large' }
  | { kind: 'file'; text: string };

type CoherenceConfigVerdict = { ok: true } | { ok: false; reason: string };

type ChangeSignalState = 'quiet' | 'anchored' | 'attested' | 'needs-decision';

type ChangeSignal =
  | { kind: 'clean' }
  | {
    kind: 'measured'; changedFiles: number; newExports: number; newVariants: number; locAdded: number;
    anchorsAdded: number; componentsAdded: number; state: ChangeSignalState;
  };

interface RedundancySite {
  file: string;
  kind: string;
  name: string;
}

interface RedundancyPair {
  a: RedundancySite;
  b: RedundancySite;
  isDiverged: boolean;
  score: number;
}

type CoherenceReading =
  | { ok: true; signal: ChangeSignal; newPairs: RedundancyPair[] }
  | { ok: false; reason: string };

const SIGNAL_STATE_PHRASES: readonly [ChangeSignalState, RegExp][] = [
  ['quiet', /no significant unanchored behavioral growth/],
  ['anchored', /behavioral growth carries a new invariant/],
  ['attested', /no-new-invariant decision recorded/],
  ['needs-decision', /significant behavioral surface has no new anchor/],
];

const SIGNAL_STATE_SENTENCES: Record<ChangeSignalState, string> = {
  quiet: 'No significant unanchored behavioral growth.',
  anchored: 'The behavioral growth carries a new invariant, boundary or parity anchor.',
  attested: 'A no-new-invariant decision is recorded for this patch.',
  'needs-decision': 'Significant behavioral surface arrives with no new invariant, boundary or parity anchor.',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function hasTrackedSymlink(lsTreeNulSeparated: string): boolean {
  return lsTreeNulSeparated.split('\0').some((entry) => entry.startsWith(TRACKED_SYMLINK_MODE));
}

function matchedCount(text: string, pattern: RegExp, group = 1): number | null {
  const match = pattern.exec(text);
  if (!match) return null;
  return Number(match[group]);
}

function parseChangeSignal(stdout: string): ChangeSignal | null {
  if (!SIGNAL_HEADER.test(stdout)) return null;
  if (SIGNAL_CLEAN.test(stdout)) return { kind: 'clean' };
  const state = SIGNAL_STATE_PHRASES.find(([, phrase]) => phrase.test(stdout))?.[0];
  const changedFiles = matchedCount(stdout, SIGNAL_CHANGED_FILES);
  const newExports = matchedCount(stdout, SIGNAL_SURFACE, 1);
  const newVariants = matchedCount(stdout, SIGNAL_SURFACE, 2);
  const locAdded = matchedCount(stdout, SIGNAL_SURFACE, 3);
  const anchorsAdded = matchedCount(stdout, SIGNAL_ANCHORS);
  const componentsAdded = matchedCount(stdout, SIGNAL_COMPONENTS);
  if (state === undefined || changedFiles === null || newExports === null || newVariants === null || locAdded === null || anchorsAdded === null || componentsAdded === null) return null;
  return { kind: 'measured', changedFiles, newExports, newVariants, locAdded, anchorsAdded, componentsAdded, state };
}

function siteFromLine(line: string): { side: string; site: RedundancySite } | null {
  const match = REDUNDANCY_SITE.exec(line);
  if (!match) return null;
  const [, side, file, kind, name] = match;
  if (MARKDOWN_ACTIVE_CHARACTERS.test(file) || MARKDOWN_ACTIVE_CHARACTERS.test(name)) return null;
  return { side, site: { file, kind, name } };
}

function parseRedundancyPairs(stdout: string): RedundancyPair[] | null {
  if (!REDUNDANCY_HEADER.test(stdout)) return null;
  const pairs: RedundancyPair[] = [];
  let siteA: RedundancySite | null = null;
  let currentScore: number | null = null;
  let currentPair: RedundancyPair | null = null;
  for (const line of stdout.split('\n')) {
    const pairStart = REDUNDANCY_PAIR_START.exec(line);
    if (pairStart) {
      siteA = null;
      currentPair = null;
      currentScore = Number(pairStart[1]);
      continue;
    }
    if (REDUNDANCY_DIVERGED.test(line)) {
      if (currentPair) currentPair.isDiverged = true;
      continue;
    }
    const parsedSite = siteFromLine(line);
    if (!parsedSite) continue;
    if (parsedSite.side === 'A') {
      siteA = parsedSite.site;
      continue;
    }
    if (!siteA || currentScore === null) continue;
    currentPair = { a: siteA, b: parsedSite.site, isDiverged: false, score: currentScore };
    pairs.push(currentPair);
    siteA = null;
  }
  return pairs;
}

function siteKey(site: RedundancySite): string {
  return `${site.file}\0${site.kind}\0${site.name}`;
}

function redundancyPairKey(pair: RedundancyPair): string {
  return [siteKey(pair.a), siteKey(pair.b)].sort().join('\n');
}

function newRedundancyPairs(headPairs: readonly RedundancyPair[], basePairs: readonly RedundancyPair[]): RedundancyPair[] {
  const baseKeys = new Set(basePairs.map(redundancyPairKey));
  return headPairs.filter((pair) => pair.score >= REDUNDANCY_REPORTING_FLOOR && !baseKeys.has(redundancyPairKey(pair)));
}

function plainUntrusted(text: string): string {
  const flattened = Array.from(text, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : character;
  }).join('');
  return flattened.replace(/[@`<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, UNTRUSTED_FIELD_MAX_CHARS);
}

function describeSite(site: RedundancySite): string {
  return `\`${site.kind}\` \`${plainUntrusted(site.name)}\` in \`${plainUntrusted(site.file)}\``;
}

function describePair(pair: RedundancyPair): string {
  const agreement = pair.isDiverged ? 'already diverged' : 'identical today';
  return `- ${describeSite(pair.a)} and ${describeSite(pair.b)} spell one domain with nothing keeping them equal (${agreement})`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function describeSignal(signal: ChangeSignal): string {
  if (signal.kind === 'clean') return 'Change signal: no changed files to assess.';
  const counts = `${plural(signal.changedFiles, 'changed file')}; +${signal.newExports} exports, +${signal.newVariants} variants, +${signal.locAdded} LOC; +${signal.anchorsAdded} anchors, +${signal.componentsAdded} components`;
  return `Change signal: ${counts}. ${SIGNAL_STATE_SENTENCES[signal.state]}`;
}

function unavailableLine(reason: string): string {
  return `Coherence reading unavailable: ${plainUntrusted(reason)}`;
}

function renderCoherenceSection(reading: CoherenceReading): string {
  if (!reading.ok) return unavailableLine(reading.reason);
  const lines = ['**Coherence** (advisory)', describeSignal(reading.signal)];
  if (reading.newPairs.length === 0) return [...lines, 'New redundancy introduced by this change: none.'].join('\n');
  lines.push(`New redundancy introduced by this change (${reading.newPairs.length}):`);
  let listedCount = 0;
  for (const pair of reading.newPairs.slice(0, MAX_LISTED_PAIRS)) {
    const pairLine = describePair(pair);
    if ([...lines, pairLine].join('\n').length > SECTION_MAX_CHARS - 40) break;
    lines.push(pairLine);
    listedCount += 1;
  }
  const unlistedCount = reading.newPairs.length - listedCount;
  if (unlistedCount > 0) lines.push(`- and ${unlistedCount} more`);
  return lines.join('\n');
}

export { COHERENCE_CONFIG_FILENAME, COHERENCE_CONFIG_MAX_BYTES, hasTrackedSymlink, judgeCoherenceConfig, newRedundancyPairs, parseChangeSignal, parseRedundancyPairs, renderCoherenceSection };
export type { CoherenceConfigEntry, CoherenceReading };
