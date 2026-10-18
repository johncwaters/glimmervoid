import type { CoherenceDecomposeFinding, CoherenceReadingRow, CoherenceRedundancyPair, CoherenceTrendWindow } from '#shared/contracts/coherence.ts';

interface CoherenceTrendPanelRow {
  label: string;
  text: string;
  configLine?: string;
}

const FINDING_LABELS: Record<CoherenceDecomposeFinding['kind'], string> = {
  'cross-boundary': 'Cross-boundary co-change',
  'missing-abstraction': 'Missing abstraction',
  'structure-hub': 'Structure hub',
};

export function coherenceTrendDirectionLabel(trend: CoherenceTrendWindow): string {
  return trend.direction;
}

function formatReading(label: string, reading: CoherenceReadingRow['drift'] | CoherenceReadingRow['decompose'] | CoherenceReadingRow['redundancy'] | CoherenceReadingRow['mass']): CoherenceTrendPanelRow {
  if (reading.status === 'unavailable') return { label, text: `Unavailable: ${reading.reason}` };
  if (reading.status === 'needs-components') return { label, text: 'Needs a component map in coherence.config.json.', configLine: reading.configLine };
  if (reading.status === 'insufficient-history') return { label, text: `Not enough history: ${reading.developmentCommits} mapped development commits.` };
  if ('developmentCommits' in reading) return { label, text: `${reading.developmentCommits} development commits; ${reading.localityPercent}% locality (${reading.locality}); component spread ${reading.spread}.` };
  if ('components' in reading) return { label, text: `${reading.components} components; ${reading.commitsAnalyzed} commits analyzed; ${reading.localityPercent}% locality.` };
  if ('pairCount' in reading) return { label, text: `${reading.pairCount} redundant pairs.` };
  return { label, text: `${reading.lines} lines, ${reading.files} files, ${reading.symbols} symbols.` };
}

function formatPair(pair: CoherenceRedundancyPair): string {
  const site = (reading: CoherenceRedundancyPair['a']) => `${reading.name} (${reading.kind}, ${reading.file})`;
  return `${site(pair.a)} and ${site(pair.b)}; similarity score ${pair.score}; ${pair.isDiverged ? 'diverged' : 'not diverged'}.`;
}

export function coherenceTrendPanelRows(latest: CoherenceReadingRow, trend: CoherenceTrendWindow): CoherenceTrendPanelRow[] {
  const rows: CoherenceTrendPanelRow[] = [
    { label: 'Direction', text: coherenceTrendDirectionLabel(trend) },
    { label: 'Comparison', text: `${trend.comparedRows} rows compared out of ${trend.rows} recorded rows. Direction tracks redundant pairs per 1,000 lines.` },
    { label: 'Redundant pairs', text: trend.redundancyPairs ? `${trend.redundancyPairs.from} to ${trend.redundancyPairs.to}` : 'Not enough comparable history.' },
    { label: 'Lines', text: trend.lines ? `${trend.lines.from} to ${trend.lines.to}` : 'Not enough comparable history.' },
    { label: 'Latest reading', text: `${latest.at} at ${latest.sha}` },
    formatReading('Drift', latest.drift),
    formatReading('Decomposition', latest.decompose),
    formatReading('Redundancy', latest.redundancy),
    formatReading('Size', latest.mass),
  ];
  if (latest.decompose.status === 'ok') {
    for (const finding of latest.decompose.topFindings) rows.push({ label: FINDING_LABELS[finding.kind], text: `${finding.subject}: ${finding.count}` });
  }
  if (latest.redundancy.status === 'ok') {
    for (const pair of latest.redundancy.topPairs) rows.push({ label: 'Top redundancy pair', text: formatPair(pair) });
  }
  return rows;
}
