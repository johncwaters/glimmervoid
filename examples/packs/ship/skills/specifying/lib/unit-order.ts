import type { DesignSpec, Unit } from "./graph.ts";

export function unitsInDependencyOrder(spec: DesignSpec): Unit[] {
  const unitsById = new Map(spec.nodes.filter((node): node is Unit => node.kind === "unit").map((unit) => [unit.id, unit]));
  const dependenciesById = new Map<string, string[]>();
  for (const edge of spec.edges) {
    if (edge.kind !== "dependsOn") continue;
    const dependencies = dependenciesById.get(edge.from) ?? [];
    dependencies.push(edge.to);
    dependenciesById.set(edge.from, dependencies);
  }
  const orderedUnits: Unit[] = [];
  const visited = new Set<string>();
  function visit(unit: Unit): void {
    if (visited.has(unit.id)) return;
    visited.add(unit.id);
    for (const dependencyId of dependenciesById.get(unit.id) ?? []) {
      const dependency = unitsById.get(dependencyId as Unit["id"]);
      if (dependency) visit(dependency);
    }
    orderedUnits.push(unit);
  }
  for (const unit of unitsById.values()) visit(unit);
  return orderedUnits;
}
