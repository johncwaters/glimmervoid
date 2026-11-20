import fs from "node:fs";
import path from "node:path";
import { machineText } from "./lib/graph.ts";
import type { Design, DesignSpec } from "./lib/graph.ts";
import { readSpec } from "./lib/read-spec.ts";
import { specArchiveDirectory } from "./lib/spec-store.ts";
import { unitsInDependencyOrder } from "./lib/unit-order.ts";

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

function problemLines(spec: DesignSpec): string[] {
  return spec.nodes.flatMap((node) => node.kind === "goal" && node.problem ? [oneLine(`Problem: ${node.problem}`)] : []);
}

function render(spec: DesignSpec, mode: string): string {
  if (mode === "goal") {
    return problemLines(spec).concat(spec.nodes.flatMap((node) => {
      if (node.kind === "goal") return [`Goal: ${node.text}`];
      return [];
    })).concat(
      spec.nodes.flatMap((node) => node.kind === "nonGoal" ? [`Non-goal: ${node.text}`] : []),
      spec.nodes.flatMap((node) => node.kind === "decision" ? [`${node.id}: ${node.question} -> ${node.answer} (${node.source})`] : []),
    ).map(oneLine).join("\n");
  }
  if (mode === "design") return renderDesign(spec);
  const nodesById = new Map(spec.nodes.map((node) => [node.id, node]));
  const lines: string[] = mode === "tree" ? problemLines(spec) : [];
  let stepNumber = 0;
  for (const unit of unitsInDependencyOrder(spec)) {
    const outgoingEdges = spec.edges.filter((edge) => edge.from === unit.id);
    const implementedIds = outgoingEdges.filter((edge) => edge.kind === "implements").map((edge) => edge.to);
    const dependencyIds = outgoingEdges.filter((edge) => edge.kind === "dependsOn").map((edge) => edge.to);
    const deferredIds = outgoingEdges.filter((edge) => edge.kind === "deferredBy").map((edge) => edge.to);
    if (mode === "plan") {
      if (deferredIds.length > 0) continue;
      stepNumber++;
      lines.push(`${stepNumber}. ${unit.id} ${oneLine(unit.title)}`);
      lines.push(`   - implements: ${implementedIds.join(", ")}`);
      lines.push(`   - reads: ${unit.reads.map(oneLine).join(", ")}`);
      lines.push(`   - changes: ${unit.changes.map(oneLine).join(", ")}`);
      lines.push(`   - checks: ${unit.checks.map((check) => `\`${oneLine(check.run)}\``).join("; ")}`);
      if (dependencyIds.length > 0) lines.push(`   - depends on: ${dependencyIds.join(", ")}`);
      continue;
    }
    lines.push(`${unit.id} ${oneLine(unit.title)}`);
    if (dependencyIds.length > 0) lines.push(`  depends on ${dependencyIds.join(" ")}`);
    lines.push(`  implements ${implementedIds.join(" ")}`);
    for (const questionId of deferredIds) {
      const question = nodesById.get(questionId);
      if (question?.kind === "openQuestion") lines.push(`  deferred by ${questionId} (${oneLine(question.question)})`);
    }
    if (unit.budgetWaiver) lines.push(`  budget waiver (${oneLine(unit.budgetWaiver)})`);
  }
  return lines.join("\n");
}

function renderDesign(spec: DesignSpec): string {
  const unitIdsByDesignId = new Map<string, string[]>();
  for (const edge of spec.edges) {
    if (edge.kind !== "implements") continue;
    unitIdsByDesignId.set(edge.to, [...(unitIdsByDesignId.get(edge.to) ?? []), edge.from]);
  }
  const designs = spec.nodes.filter((node): node is Design => node.kind === "design");
  const lines: string[] = [];
  for (const layer of ["behavior", "architecture", "program", "machine"] as const) {
    const designsInLayer = designs.filter((design) => design.layer === layer);
    if (designsInLayer.length === 0) continue;
    lines.push(layer);
    for (const design of designsInLayer) {
      lines.push(`  ${design.id} ${oneLine(design.title)}${design.at ? ` (${oneLine(design.at)})` : ""}`);
      lines.push(...(design.layer === "machine" ? machineText(design) : design.code ?? "").split("\n").map((codeLine) => `    ${codeLine}`));
      lines.push(`    built by ${(unitIdsByDesignId.get(design.id) ?? []).join(", ") || "no unit yet"}`);
    }
  }
  return lines.join("\n");
}

function renderSpec(specArgument: string | undefined, mode: string | undefined): number {
  const { report, spec } = readRenderableSpec(specArgument);
  if (!spec) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 1;
  }
  if (mode !== "tree" && mode !== "plan" && mode !== "goal" && mode !== "design") {
    process.stdout.write(`${JSON.stringify({ outcome: "INVALID", errors: ["Rule 1: render mode: supply tree, plan, goal, or design"] })}\n`);
    return 1;
  }
  process.stdout.write(`${render(spec, mode)}\n`);
  return 0;
}

function readRenderableSpec(specArgument: string | undefined): ReturnType<typeof readSpec> {
  const archiveDirectory = specArchiveDirectory();
  if (!specArgument || !path.resolve(specArgument).startsWith(`${archiveDirectory}${path.sep}`)) return readSpec(specArgument);
  try {
    const spec = JSON.parse(fs.readFileSync(specArgument, "utf8")) as DesignSpec;
    return { spec, report: { outcome: "VALID", errors: [] } };
  } catch (error) {
    return { report: { outcome: "UNREADABLE", errors: [String(error).replace(/[\r\n]+/g, " ")] } };
  }
}

process.exitCode = renderSpec(process.argv[2], process.argv[3]);
