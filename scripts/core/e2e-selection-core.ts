import { originByDependentPath } from '../../server/core/import-graph-core.ts';

interface ScenarioSeeds {
  scenario: string;
  seeds: readonly string[];
  supportPaths: readonly string[];
}

interface SelectedScenario {
  scenario: string;
  reasons: readonly string[];
}

interface SelectionInput {
  changedPaths: readonly string[];
  scenarios: readonly ScenarioSeeds[];
  dependentsByPath: ReadonlyMap<string, ReadonlySet<string>>;
  economyClosure: ReadonlySet<string> | null;
}

function isUnderSupportPath(changedPath: string, supportPath: string): boolean {
  if (supportPath.endsWith('/')) return changedPath.startsWith(supportPath);
  return changedPath === supportPath;
}

function selectScenarios({ changedPaths, scenarios, dependentsByPath, economyClosure }: SelectionInput): SelectedScenario[] {
  const changedOriginBySeed = originByDependentPath(dependentsByPath, changedPaths);
  return scenarios.flatMap((scenario) => {
    const importReasons = scenario.seeds.flatMap((seed) => {
      const changedOrigin = changedOriginBySeed.get(seed);
      if (changedOrigin === undefined) return [];
      return [changedOrigin === seed ? `${seed} changed` : `${seed} imports ${changedOrigin}`];
    });
    const coherenceReasons = economyClosure === null ? [] : scenario.seeds.filter((seed) => economyClosure.has(seed)).map((seed) => `coherence: ${seed}`);
    const harnessReasons = changedPaths.filter((changedPath) => scenario.supportPaths.some((supportPath) => isUnderSupportPath(changedPath, supportPath))).map((changedPath) => `harness ${changedPath}`);
    const reasons = [...new Set([...importReasons, ...coherenceReasons, ...harnessReasons])];
    return reasons.length === 0 ? [] : [{ scenario: scenario.scenario, reasons }];
  });
}

export { selectScenarios };
export type { ScenarioSeeds, SelectedScenario };
