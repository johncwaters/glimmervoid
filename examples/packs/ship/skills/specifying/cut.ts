import fs from "node:fs";
import path from "node:path";
import { listPathWithAncestors, machineText, oneLine, unitTicketCriteria } from "./lib/graph.ts";
import type { DesignSpec } from "./lib/graph.ts";
import { readSpec } from "./lib/read-spec.ts";
import { unitsInDependencyOrder } from "./lib/unit-order.ts";

function normalizeScope(scope: string): string {
  return scope.trim().replace(/\\/g, "/").split("/").filter((segment) => segment !== "" && segment !== ".").join("/");
}

function removeContainedScopes(scopes: string[]): string[] {
  const distinctScopes = new Set(scopes);
  return [...distinctScopes].filter((scope) =>
    !listPathWithAncestors(scope).slice(1).some((ancestorScope) => distinctScopes.has(ancestorScope)));
}

function renderIntent(spec: DesignSpec, specPath: string) {
  const goal = spec.nodes.find((node) => node.kind === "goal")!;
  const nodesById = new Map(spec.nodes.map((node) => [node.id, node]));
  const nonGoals = spec.nodes.flatMap((node) => node.kind === "nonGoal" ? [node.text] : []);
  const constraints = spec.nodes.flatMap((node) => node.kind === "decision" && node.isConstraint === true ? [node.answer] : []);
  const edgesByFrom = new Map<string, DesignSpec["edges"]>();
  for (const edge of spec.edges) {
    const outgoingEdges = edgesByFrom.get(edge.from) ?? [];
    outgoingEdges.push(edge);
    edgesByFrom.set(edge.from, outgoingEdges);
  }
  const tickets = unitsInDependencyOrder(spec).map((unit) => {
    const outgoingEdges = edgesByFrom.get(unit.id) ?? [];
    const designs = outgoingEdges.flatMap((edge) => {
      const design = edge.kind === "implements" ? nodesById.get(edge.to) : undefined;
      return design?.kind === "design" ? [design] : [];
    });
    const designBlock = designs.map((design) => `${oneLine(design.title)}${design.at ? ` (${oneLine(design.at)})` : ""}:\n${design.layer === "machine" ? machineText(design) : design.code}${design.board ? `\nMockups on board ${design.board.id} (boxes ${design.board.boxes.join(", ")}); build from the HTML: ${design.board.pages.join(", ")}` : ""}`).join("\n\n");
    const decisions = outgoingEdges.flatMap((edge) => {
      if (edge.kind !== "implements") return [];
      const decision = nodesById.get(edge.to);
      if (decision?.kind !== "decision" || decision.isConstraint === true) return [];
      return [decision];
    });
    const choices = decisions.filter((decision) => decision.source !== "read").map((decision) => `${decision.question} ${decision.answer}`);
    const context = decisions.filter((decision) => decision.source === "read")
      .map((decision) => decision.evidence ? `${decision.answer} (${decision.evidence})` : decision.answer);
    const title = oneLine(unit.title);
    const objective = `${title}${title.endsWith(".") ? "" : "."}`
      + (choices.length > 0 ? ` Decisions: ${choices.join(" ")}` : "")
      + (context.length > 0 ? ` Context: ${context.join(" ")}` : "")
      + (unit.reads.length > 0 ? ` Read first: ${unit.reads.join(", ")}` : "");
    return {
      id: unit.id,
      objective: oneLine(objective) + (designBlock === "" ? "" : `\nDesign:\n${designBlock}`),
      criteria: unitTicketCriteria(unit, goal.criteria ?? []),
      dependsOn: outgoingEdges.filter((edge) => edge.kind === "dependsOn").map((edge) => edge.to),
      writeScopes: [...new Set(unit.changes.map(normalizeScope))],
    };
  });
  const boundary = `Repository ${path.basename(path.dirname(specPath))}.`
    + (nonGoals.length > 0 ? ` Non-goals: ${nonGoals.join(" ")}` : "")
    + (constraints.length > 0 ? ` Constraints: ${constraints.join(" ")}` : "");
  return {
    name: oneLine(path.basename(specPath, ".json")),
    objective: oneLine(goal.text),
    criteria: (goal.criteria ?? []).map(oneLine),
    risk: goal.risk ?? "",
    boundary: oneLine(boundary),
    writeScopes: removeContainedScopes(tickets.flatMap((ticket) => ticket.writeScopes)),
    reviewGate: spec.reviewGate ?? "gating-reviews",
    tickets,
  };
}

function collectRefusalErrors(spec: DesignSpec): string[] {
  const errors: string[] = [];
  if (spec.status !== "challenged") errors.push(`intent: change status from ${spec.status} to challenged`);
  const nodesById = new Map(spec.nodes.map((node) => [node.id, node]));
  for (const edge of spec.edges) {
    if (edge.kind !== "deferredBy") continue;
    const question = nodesById.get(edge.to);
    if (question?.kind === "openQuestion") errors.push(`${edge.from}: settle open question ${question.id}: ${oneLine(question.question)} and remove its deferredBy edge`);
  }
  const goal = spec.nodes.find((node) => node.kind === "goal")!;
  if (goal.risk === undefined) errors.push("intent: supply goal G1.risk");
  if (goal.criteria === undefined) errors.push("intent: supply goal G1.criteria");
  for (const node of spec.nodes) {
    if (node.kind !== "unit") continue;
    for (const changedPath of node.changes) {
      const trimmedPath = changedPath.trim();
      const scope = normalizeScope(changedPath);
      if (trimmedPath !== oneLine(changedPath)) errors.push(`${node.id}: replace changes path ${oneLine(changedPath)} with the exact path, free of whitespace runs and of whitespace other than a single plain space`);
      if (scope === "") errors.push(`${node.id}: replace changes path ${oneLine(changedPath)} with one that names a file or folder below the repository root`);
      const isAbsolutePath = trimmedPath.replace(/\\/g, "/").startsWith("/");
      if (!scope.split("/").includes("..") && !/^-|^[a-z]:/i.test(scope) && !isAbsolutePath && !/[\x00-\x1f\x7f-\x9f]/.test(changedPath)) continue;
      errors.push(`${node.id}: replace changes path ${oneLine(changedPath)} with a relative write scope without '..' segments, a leading '-', '/', drive letter, or control characters`);
    }
  }
  return errors.map(oneLine);
}

function resolveIntentPath(specPath: string): string {
  return path.join(path.dirname(specPath), `${path.basename(specPath, ".json")}.intent.json`);
}

function removeStaleIntent(specArgument: string | undefined): void {
  if (!specArgument) return;
  fs.rmSync(resolveIntentPath(path.resolve(specArgument)), { force: true });
}

function cutSpec(specArgument: string | undefined): number {
  const { report, spec } = readSpec(specArgument);
  if (!specArgument || !spec) {
    removeStaleIntent(specArgument);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 1;
  }
  const specPath = path.resolve(specArgument);
  const intentPath = resolveIntentPath(specPath);
  const errors = collectRefusalErrors(spec);
  if (errors.length > 0) {
    fs.rmSync(intentPath, { force: true });
    process.stdout.write(`${JSON.stringify({ outcome: "REFUSED", errors })}\n`);
    return 1;
  }
  const intent = renderIntent(spec, specPath);
  fs.writeFileSync(intentPath, `${JSON.stringify(intent, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ outcome: "CUT", intentPath, tickets: intent.tickets.length })}\n`);
  return 0;
}

process.exitCode = cutSpec(process.argv[2]);
