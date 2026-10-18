import {
  COHERENCE_READING_PATH_MAX_CHARS, COHERENCE_READING_TEXT_MAX_CHARS, COHERENCE_READING_TOP_ITEMS, COHERENCE_TREND_WINDOW_ROWS, CoherenceDecomposeReading,
  CoherenceDriftReading, CoherenceMassReading, CoherenceReadingRow, CoherenceRedundancyReading,
} from '../../shared/contracts/coherence.ts';
import type { CoherenceDecomposeFinding, CoherenceRedundancyPair, CoherenceTrendWindow } from '../../shared/contracts/coherence.ts';
import { parseRedundancyPairs } from '../github/core/team-review-coherence-core.ts';
import { decideCoherenceAttachment } from './coherence-session-core.ts';

type CoherenceReadingVerb = 'drift' | 'decompose' | 'redundancy' | 'mass';
type Unavailable = { status: 'unavailable'; reason: string };
type NeedsComponents = { status: 'needs-components'; configLine: string };
type CoherenceVerbReadings = Omit<CoherenceReadingRow, 'sha' | 'at'>;

const COHERENCE_READING_SERIES_MAX_ROWS = 500;
const TREND_DENSITY_TOLERANCE = 0.1;
const LINES_PER_DENSITY_UNIT = 1000;

const COHERENCE_READING_UNAVAILABLE = Object.freeze({
  noCli: 'the coherence CLI could not be resolved',
  timedOut: 'the reading timed out',
  failed: 'the reading failed',
  unrecognized: 'the reading output was not recognized',
  guardrails: 'the guardrails sandbox could not start',
  snapshotFailed: 'the integration tip could not be snapshotted',
  massCommands: 'the repo declares mass commands',
  invalid: 'the reading did not fit the reading shape',
});

const NEEDS_COMPONENTS_CONFIG_LINE = '"components": [{ "name": "<component>", "files": ["<folder>/**"] }]';

const DRIFT_HEADER = /^direction\s+\S+\s+architectural trajectory/m;
const DRIFT_INSUFFICIENT = /only (\d+) mapped development commits/;
const DRIFT_COMMITS = /^\s*(\d+) development commits\s/m;
const DRIFT_LOCALITY = /^\s*LOCALITY\s+\S+\s+\d+%\s+\S+\s+(\d+)%\s+\S+\s+(converging|decohering|flat)\s*$/m;
const DRIFT_SPREAD = /^\s*SPREAD\s+\S+\s+\d+(?:\.\d+)?\s+\S+\s+\d+(?:\.\d+)?\s+\S+\s+(widening|narrowing|flat)\s*$/m;
const DECOMPOSE_HEADER = /^decomposition\s+\S+\s+three-graph agreement/m;
const DECOMPOSE_COUNTS = /^\s*(\d+) components \S (\d+) commits analyzed/m;
const DECOMPOSE_LOCALITY = /^\s*LOCALITY (\d+)%/m;
const REDUNDANCY_ABOVE_FLOOR = /(\d+) above the reporting floor/;
const MASS_HEADER = /^\s*MASS\s/m;
const MASS_LINES = /^\s*lines\|total\s+(\d+)\s/m;
const MASS_FILES = /^\s*files\|total\s+(\d+)\s/m;
const MASS_SYMBOLS = /^\s*symbols\|total\s+(\d+)\s/m;

const DECOMPOSE_SECTIONS: readonly { heading: string; kind: CoherenceDecomposeFinding['kind']; entry: RegExp }[] = [
  { heading: 'cross-boundary co-change', kind: 'cross-boundary', entry: /^ {4,7}(\d+)\u00d7 {2}(\S.*? {2}\u21c4 {2}\S.*?)\s*$/ },
  { heading: 'missing abstraction', kind: 'missing-abstraction', entry: /^ {4}(\d+) concerns {2}(\S.*?)\s*$/ },
  { heading: 'structure hubs', kind: 'structure-hub', entry: /^ {4}(\d+) importers {2}(\S.*?)\s*$/ },
];

function unrecognized(): Unavailable {
  return { status: 'unavailable', reason: COHERENCE_READING_UNAVAILABLE.unrecognized };
}

function needsComponents(): NeedsComponents {
  return { status: 'needs-components', configLine: NEEDS_COMPONENTS_CONFIG_LINE };
}

function clipText(text: string, maxChars: number): string {
  const printable = Array.from(text, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : character;
  }).join('');
  return printable.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function safeCount(text: string | undefined): number | null {
  const count = Number(text);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function percent(text: string): number {
  return Math.min(100, Number(text));
}

function hasComponentsMap(configText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(configText);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const components: unknown = Reflect.get(parsed, 'components');
    return Array.isArray(components) && components.length > 0;
  } catch {
    return false;
  }
}

function hasDeclaredMassCommands(configText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(configText);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const mass: unknown = Reflect.get(parsed, 'mass');
    if (typeof mass !== 'object' || mass === null) return false;
    const measures: unknown = Reflect.get(mass, 'measures');
    if (measures === undefined || measures === null) return false;
    return !Array.isArray(measures) || measures.length > 0;
  } catch {
    return true;
  }
}

function refusedMassCommands(): Unavailable {
  return { status: 'unavailable', reason: COHERENCE_READING_UNAVAILABLE.massCommands };
}

function parseDriftOutput(stdout: string): CoherenceDriftReading {
  if (!DRIFT_HEADER.test(stdout)) return unrecognized();
  const insufficient = DRIFT_INSUFFICIENT.exec(stdout);
  if (insufficient) {
    const insufficientCommits = safeCount(insufficient[1]);
    return insufficientCommits === null ? unrecognized() : { status: 'insufficient-history', developmentCommits: insufficientCommits };
  }
  const developmentCommits = safeCount(DRIFT_COMMITS.exec(stdout)?.[1]);
  const locality = DRIFT_LOCALITY.exec(stdout);
  const spread = DRIFT_SPREAD.exec(stdout);
  if (developmentCommits === null || !locality || !spread) return unrecognized();
  const localityVerdict = locality[2] === 'converging' || locality[2] === 'decohering' ? locality[2] : 'flat';
  const spreadVerdict = spread[1] === 'widening' || spread[1] === 'narrowing' ? spread[1] : 'flat';
  return { status: 'ok', developmentCommits, localityPercent: percent(locality[1]), locality: localityVerdict, spread: spreadVerdict };
}

function decomposeFindings(stdout: string): CoherenceDecomposeFinding[] {
  const findings: CoherenceDecomposeFinding[] = [];
  let section: (typeof DECOMPOSE_SECTIONS)[number] | null = null;
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') {
      section = null;
      continue;
    }
    const opened = DECOMPOSE_SECTIONS.find((candidate) => line.trim().startsWith(candidate.heading));
    if (opened) {
      section = opened;
      continue;
    }
    const entry = section?.entry.exec(line);
    const count = safeCount(entry?.[1]);
    if (!section || !entry || count === null) continue;
    findings.push({ kind: section.kind, subject: clipText(entry[2], COHERENCE_READING_TEXT_MAX_CHARS), count });
  }
  return findings.slice(0, COHERENCE_READING_TOP_ITEMS);
}

function parseDecomposeOutput(stdout: string): CoherenceDecomposeReading {
  if (!DECOMPOSE_HEADER.test(stdout)) return unrecognized();
  const counts = DECOMPOSE_COUNTS.exec(stdout);
  const components = safeCount(counts?.[1]);
  const commitsAnalyzed = safeCount(counts?.[2]);
  const locality = DECOMPOSE_LOCALITY.exec(stdout);
  if (components === null || commitsAnalyzed === null || !locality) return unrecognized();
  return {
    status: 'ok', components, commitsAnalyzed, localityPercent: percent(locality[1]), topFindings: decomposeFindings(stdout),
  };
}

function parseRedundancyOutput(stdout: string): CoherenceRedundancyReading {
  const pairs = parseRedundancyPairs(stdout);
  const pairCount = safeCount(REDUNDANCY_ABOVE_FLOOR.exec(stdout)?.[1]);
  if (!pairs || pairCount === null) return unrecognized();
  const clipSite = (site: { file: string; kind: string; name: string }) => ({
    file: clipText(site.file, COHERENCE_READING_PATH_MAX_CHARS), kind: clipText(site.kind, COHERENCE_READING_TEXT_MAX_CHARS), name: clipText(site.name, COHERENCE_READING_TEXT_MAX_CHARS),
  });
  const topPairs: CoherenceRedundancyPair[] = pairs.slice(0, COHERENCE_READING_TOP_ITEMS)
    .map((pair) => ({ a: clipSite(pair.a), b: clipSite(pair.b), score: pair.score, isDiverged: pair.isDiverged }));
  return { status: 'ok', pairCount, topPairs };
}

function parseMassOutput(stdout: string): CoherenceMassReading {
  if (!MASS_HEADER.test(stdout)) return unrecognized();
  const lines = safeCount(MASS_LINES.exec(stdout)?.[1]);
  const files = safeCount(MASS_FILES.exec(stdout)?.[1]);
  const symbols = safeCount(MASS_SYMBOLS.exec(stdout)?.[1]);
  if (lines === null || files === null || symbols === null) return unrecognized();
  return { status: 'ok', lines, files, symbols };
}

function invalidReading(): Unavailable {
  return { status: 'unavailable', reason: COHERENCE_READING_UNAVAILABLE.invalid };
}

function admitVerbReadings({ drift, decompose, redundancy, mass }: CoherenceVerbReadings): CoherenceVerbReadings {
  return {
    drift: CoherenceDriftReading.safeParse(drift).data ?? invalidReading(),
    decompose: CoherenceDecomposeReading.safeParse(decompose).data ?? invalidReading(),
    redundancy: CoherenceRedundancyReading.safeParse(redundancy).data ?? invalidReading(),
    mass: CoherenceMassReading.safeParse(mass).data ?? invalidReading(),
  };
}

function redundancyDensity({ pairs, lines }: { pairs: number; lines: number }): number {
  return (pairs * LINES_PER_DENSITY_UNIT) / Math.max(lines, 1);
}

function summarizeCoherenceTrend(rows: readonly CoherenceReadingRow[]): CoherenceTrendWindow {
  const window = rows.slice(-COHERENCE_TREND_WINDOW_ROWS);
  const comparable = window.flatMap((row) => (row.redundancy.status === 'ok' && row.mass.status === 'ok'
    ? [{ pairs: row.redundancy.pairCount, lines: row.mass.lines }] : []));
  const oldest = comparable[0];
  const newest = comparable[comparable.length - 1];
  if (comparable.length < 2 || !oldest || !newest) {
    return { direction: 'steady', rows: window.length, comparedRows: comparable.length, redundancyPairs: null, lines: null };
  }
  const oldestDensity = redundancyDensity(oldest);
  const newestDensity = redundancyDensity(newest);
  const isDecohering = newestDensity > oldestDensity * (1 + TREND_DENSITY_TOLERANCE);
  const isConverging = newestDensity < oldestDensity * (1 - TREND_DENSITY_TOLERANCE);
  return {
    direction: isDecohering ? 'decohering' : isConverging ? 'converging' : 'steady',
    rows: window.length,
    comparedRows: comparable.length,
    redundancyPairs: { from: oldest.pairs, to: newest.pairs },
    lines: { from: oldest.lines, to: newest.lines },
  };
}

function parseReadingRowLine(line: string): CoherenceReadingRow[] {
  if (line.trim() === '') return [];
  try {
    const parsed = CoherenceReadingRow.safeParse(JSON.parse(line));
    return parsed.success ? [parsed.data] : [];
  } catch {
    return [];
  }
}

function parseReadingSeries(text: string): CoherenceReadingRow[] {
  return text.split('\n').flatMap(parseReadingRowLine).slice(-COHERENCE_READING_SERIES_MAX_ROWS);
}

function isProjectWatched({ isFactoryEnabled, isSettingOn }: { isFactoryEnabled: boolean; isSettingOn: boolean }): boolean {
  return decideCoherenceAttachment({ sessionKind: isFactoryEnabled ? 'factory' : 'writer', isSettingOn });
}

export {
  admitVerbReadings, COHERENCE_READING_SERIES_MAX_ROWS, COHERENCE_READING_UNAVAILABLE, hasComponentsMap, hasDeclaredMassCommands, isProjectWatched, needsComponents,
  parseDecomposeOutput, parseDriftOutput, parseMassOutput, parseReadingSeries, parseRedundancyOutput, refusedMassCommands, summarizeCoherenceTrend,
};
export type { CoherenceReadingVerb, CoherenceVerbReadings };
