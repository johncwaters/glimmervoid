import {
  CHANGE_MAP_CLAIM_MAX_CHARS, CHANGE_MAP_CLAIMS_MAX, CHANGE_MAP_LIST_CAP,
} from '../../shared/contracts/change-map.ts';
import type { BlastRadiusFact, ChangeMap, ChangeNarrative, CrossRepoLink, SubsystemFact } from '../../shared/contracts/change-map.ts';

type FactGroup = 'files' | 'subsystems' | 'coChangeGaps' | 'hotspots' | 'blastRadius' | 'untestedFiles' | 'collisions' | 'links';
const FACT_GROUPS: readonly FactGroup[] = [
  'files', 'subsystems', 'coChangeGaps', 'hotspots', 'blastRadius', 'untestedFiles', 'collisions', 'links',
];

function narrativeFacts(map: ChangeMap) {
  return {
    repos: map.repos.map((repo) => ({
      name: repo.name,
      base: repo.base,
      totalCounts: Object.fromEntries(FACT_GROUPS.map((group) => [group, repo[group].length])),
      files: capFacts(repo.files, compareFactIds),
      subsystems: capFacts(repo.subsystems, compareFactIds).map(capSubsystemPaths),
      coChangeGaps: capFacts(repo.coChangeGaps, compareFactIds),
      hotspots: capFacts(repo.hotspots, compareFactIds),
      blastRadius: capFacts(repo.blastRadius, compareBlastRadius),
      untestedFiles: capFacts(repo.untestedFiles, compareFactIds),
      collisions: capFacts(repo.collisions, compareFactIds),
      links: capFacts(repo.links, compareLinks),
    })).sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function capFacts<Fact>(facts: Fact[], compare: (left: Fact, right: Fact) => number): Fact[] {
  return [...facts].sort(compare).slice(0, CHANGE_MAP_LIST_CAP);
}

function capSubsystemPaths(subsystem: SubsystemFact) {
  return { ...subsystem, paths: subsystem.paths.slice(0, CHANGE_MAP_LIST_CAP), pathCount: subsystem.paths.length };
}

function compareFactIds(left: { factId: string }, right: { factId: string }): number {
  return left.factId.localeCompare(right.factId);
}

function compareBlastRadius(left: BlastRadiusFact, right: BlastRadiusFact): number {
  return right.transitiveDependentCount - left.transitiveDependentCount || compareFactIds(left, right);
}

function compareLinks(left: CrossRepoLink, right: CrossRepoLink): number {
  return right.changedImporterCount - left.changedImporterCount || right.importerCount - left.importerCount || compareFactIds(left, right);
}

function factsHashInput(map: ChangeMap): string {
  return JSON.stringify(narrativeFacts(map), (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    }));
  });
}

function hasNarratableFacts(map: ChangeMap): boolean {
  return map.repos.some((repo) => repo.files.length > 0);
}

function knownNarrativeFactIds(map: ChangeMap): Set<string> {
  const knownFactIds = new Set<string>();
  for (const repo of narrativeFacts(map).repos) {
    for (const group of FACT_GROUPS) {
      for (const fact of repo[group]) knownFactIds.add(fact.factId);
    }
  }
  return knownFactIds;
}

function buildNarrativePrompt({ facts, resultPath }: { facts: ReturnType<typeof narrativeFacts>; resultPath: string | null }): string {
  const deliveryLines = resultPath
    ? ['Use no tools except Write to the exact result file path below.', 'Write']
    : ['Answer with the JSON as your final message and write no files.', 'Return'];
  return [
    'The facts below are your only source of truth. Read nothing else.',
    deliveryLines[0],
    `${deliveryLines[1]} JSON { "claims": [{ "text": string, "factIds": string[] }] } with at most ${CHANGE_MAP_CLAIMS_MAX} claims.`,
    'Each claim must be one or two plain-English sentences about how a change connects to the codebase or what risk it carries.',
    'Every claim must cite one or more factIds copied exactly from the facts. Do not invent facts or identifiers.',
    'When links are present, lead with how a change in one repository reaches another through them.',
    `Each fact list and subsystem path list holds at most ${CHANGE_MAP_LIST_CAP} entries; totalCounts and pathCount give the full sizes.`,
    `Keep each claim within ${CHANGE_MAP_CLAIM_MAX_CHARS} characters.`,
    ...(resultPath ? [`Result file: ${resultPath}`] : []),
    `Facts JSON: ${JSON.stringify(facts)}`,
  ].join('\n');
}

function validateNarrative({ raw, knownFactIds, factsHash, model }: {
  raw: unknown;
  knownFactIds: ReadonlySet<string>;
  factsHash: string;
  model: string | null;
}): ChangeNarrative | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const offeredClaims = 'claims' in raw ? raw.claims : null;
  if (!Array.isArray(offeredClaims)) return null;
  const claims: ChangeNarrative['claims'] = [];
  for (const offeredClaim of offeredClaims) {
    if (!offeredClaim || typeof offeredClaim !== 'object' || Array.isArray(offeredClaim)) continue;
    const text = 'text' in offeredClaim ? offeredClaim.text : null;
    const factIds = 'factIds' in offeredClaim ? offeredClaim.factIds : null;
    if (typeof text !== 'string' || text.length > CHANGE_MAP_CLAIM_MAX_CHARS) continue;
    if (!Array.isArray(factIds)) continue;
    const cleanText = text.replaceAll(String.fromCharCode(0x2014), '-').replaceAll(String.fromCharCode(0x2013), '-').replaceAll(String.fromCharCode(0x2026), '...').trim();
    if (!cleanText || cleanText.length > CHANGE_MAP_CLAIM_MAX_CHARS) continue;
    const citedFactIds = [...new Set(factIds.filter((factId): factId is string => typeof factId === 'string' && knownFactIds.has(factId)))];
    if (citedFactIds.length === 0) continue;
    claims.push({ text: cleanText, factIds: citedFactIds });
    if (claims.length >= CHANGE_MAP_CLAIMS_MAX) break;
  }
  if (claims.length === 0) return null;
  return { factsHash, model, claims };
}

export { buildNarrativePrompt, factsHashInput, hasNarratableFacts, knownNarrativeFactIds, narrativeFacts, validateNarrative };
