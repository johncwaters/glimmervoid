import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type Goal = {
  id: "G1";
  kind: "goal";
  text: string;
  risk?: "low" | "medium" | "high" | "critical";
  criteria?: string[];
  upstream?: string;
  problem?: string;
};
export type NonGoal = { id: `N${number}`; kind: "nonGoal"; text: string };
export type Branch = { id: `B${number}`; kind: "branch"; question: string; leaning: string; upstream: string };
export type Decision = {
  id: `D${number}`;
  kind: "decision";
  question: string;
  answer: string;
  why: string;
  source: "decided" | "read" | "assumed";
  evidence?: string;
  isConstraint?: boolean;
  lifecycle?: "none";
  mockup?: "none";
};
export type OpenQuestion = { id: `Q${number}`; kind: "openQuestion"; question: string; settledBy: string };
export type Unit = {
  id: `U${number}`;
  kind: "unit";
  title: string;
  reads: string[];
  changes: string[];
  checks: { run: string }[];
  serves?: number[];
  budgetWaiver?: string;
  splits?: string;
};
export type Design = {
  id: `I${number}`;
  kind: "design";
  layer: "behavior" | "architecture" | "program" | "machine";
  title: string;
  code?: string;
  at?: string;
  states?: string[];
  transitions?: [string, string, string][];
  board?: MockupBoard;
};
export type MockupBoard = { id: string; boxes: string[]; pages: string[] };
export type Node = Goal | NonGoal | Branch | Decision | OpenQuestion | Unit | Design;
export type EdgeKind = "blocks" | "implements" | "dependsOn" | "deferredBy";
export type Edge = { from: Node["id"]; kind: EdgeKind; to: Node["id"] };
export const REVIEW_GATES = ["gating-reviews"] as const;
export type ReviewGate = (typeof REVIEW_GATES)[number];
export type DesignSpec = {
  status: "sketch" | "grilled" | "sliced" | "challenged";
  request: string;
  repoRoot: string;
  nodes: Node[];
  edges: Edge[];
  challengeStamp?: string;
  challengedUnitIds?: string[];
  reviewGate?: ReviewGate;
};

export const READING_BUDGET_BYTES = 200000;
const CHANGED_ONLY_PATH_CAP_BYTES = 20000;
const REPO_GATE_COMMAND = /^(npm|pnpm|yarn)\s+(run\s+)?(typecheck|lint|test)$/;
const UNIT_TITLE_LIMIT = 120;
export const NO_UPSTREAM = /^none:\s*\S*[A-Za-z]\S*\s+\S*[A-Za-z]/;
const UPSTREAM_PATH_OR_COMMAND = /[\w./-]+\.[A-Za-z]\w*:\d+|`[^`\s]+\s[^`]*[-/.=]\w[^`]*`|https?:\/\/[\w-]+(?:\.[\w-]+)+/;
const HEX_RUN = /(?<![\w-])[0-9a-f]{7,40}(?![\w-])/g;
const SHA_SHAPE = /^(?=.*\d)(?=.*[a-f])/;
const COMMIT_LOOKUP_TIMEOUT_MS = 2000;
const CITATION_FORMS = "path:line, the sha of a commit in repoRoot, a fetched page's URL, or a backticked command with its arguments";

export function oneLine(text: string): string {
  return text.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, " ").trim();
}

export function unitTicketCriteria(unit: Unit, goalCriteria: string[]): string[] {
  return [...new Set([
    ...(unit.serves ?? []).map((criterionNumber) => oneLine(goalCriteria[criterionNumber - 1] ?? "")),
    ...unit.checks.map((check) => oneLine(`The command ${check.run} exits 0.`)),
  ])];
}

const UI_FILE_EXTENSIONS = new Set(["tsx", "jsx", "vue", "svelte", "astro", "html", "htm", "css", "scss", "sass", "less", "mdx", "erb", "hbs", "ejs", "pug", "njk", "liquid", "twig", "jinja"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git"]);
const NODE_FIELDS = {
  goal: ["id", "kind", "text", "risk", "criteria", "upstream", "problem"],
  nonGoal: ["id", "kind", "text"],
  branch: ["id", "kind", "question", "leaning", "upstream"],
  decision: ["id", "kind", "question", "answer", "why", "source", "evidence", "isConstraint", "lifecycle", "mockup"],
  openQuestion: ["id", "kind", "question", "settledBy"],
  unit: ["id", "kind", "title", "reads", "changes", "checks", "serves", "budgetWaiver", "splits"],
  design: ["id", "kind", "layer", "title", "code", "at", "states", "transitions", "board"],
} satisfies Record<Node["kind"], string[]>;
const NODE_ID_PATTERNS = {
  goal: /^G1$/,
  nonGoal: /^N[1-9]\d*$/,
  branch: /^B[1-9]\d*$/,
  decision: /^D[1-9]\d*$/,
  openQuestion: /^Q[1-9]\d*$/,
  unit: /^U[1-9]\d*$/,
  design: /^I[1-9]\d*$/,
};
const EDGE_ENDPOINT_KINDS = {
  blocks: ["branch", ["branch"]],
  implements: ["unit", ["decision", "design"]],
  dependsOn: ["unit", ["unit"]],
  deferredBy: ["unit", ["openQuestion"]],
} satisfies Record<EdgeKind, [Node["kind"], Node["kind"][]]>;
const CHALLENGE_STAMP_PATTERN = /^CHALLENGE: \d+ kept, \d+ shrunk, \d+ cut\b/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addError(errors: string[], rule: number, subject: string, fix: string): void {
  errors.push(`Rule ${rule}: ${subject}: ${fix}`.replace(/[\r\n]+/g, " "));
}

function rejectUnknownFields(value: Record<string, unknown>, allowedFields: string[], subject: string, errors: string[]): void {
  for (const field of Object.keys(value)) {
    if (allowedFields.includes(field)) continue;
    addError(errors, 1, subject, `remove unknown field ${field}`);
  }
}

function requireString(value: unknown, subject: string, errors: string[]): void {
  if (typeof value === "string" && value.trim().length > 0) return;
  addError(errors, 1, subject, "supply a non-empty string");
}

function listHexRuns(text: string): string[] {
  return text.match(HEX_RUN) ?? [];
}

function readCitedText(node: unknown): string {
  if (!isRecord(node)) return "";
  const citedText = node.kind === "decision" ? node.evidence : node.upstream;
  return typeof citedText === "string" ? citedText : "";
}

function readCommitsCited(nodes: unknown[], repoRoot: unknown): Set<string> | undefined {
  const citationsNeedingACommit = nodes.map(readCitedText).filter((citedText) => !NO_UPSTREAM.test(citedText) && !UPSTREAM_PATH_OR_COMMAND.test(citedText));
  const hexRuns = [...new Set(citationsNeedingACommit.flatMap(listHexRuns))];
  if (hexRuns.length === 0) return new Set();
  if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)) return undefined;
  const gitProcess = spawnSync("git", ["-C", repoRoot, "cat-file", "--batch-check"], {
    input: hexRuns.map((hexRun) => `${hexRun}^{commit}\n`).join(""),
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" },
    timeout: COMMIT_LOOKUP_TIMEOUT_MS,
  });
  if (gitProcess.error || gitProcess.status !== 0) return undefined;
  const answers = gitProcess.stdout.split("\n");
  return new Set(hexRuns.filter((_, hexRunIndex) => / commit \d+$/.test(answers[hexRunIndex] ?? "")));
}

function citesCommit(upstream: string, commitsCited: Set<string> | undefined): boolean {
  const hexRuns = listHexRuns(upstream);
  if (commitsCited === undefined) return hexRuns.some((hexRun) => SHA_SHAPE.test(hexRun));
  return hexRuns.some((hexRun) => commitsCited.has(hexRun));
}

function citesSource(citedText: string, commitsCited: Set<string> | undefined, allowsNone: boolean): boolean {
  if (allowsNone && NO_UPSTREAM.test(citedText)) return true;
  return UPSTREAM_PATH_OR_COMMAND.test(citedText) || citesCommit(citedText, commitsCited);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim() !== "");
}

function listUnreachableStates(states: string[], transitions: [string, string, string][]): string[] {
  const reachedStates = new Set([states[0]]);
  const pendingStates = [states[0]];
  for (let index = 0; index < pendingStates.length; index += 1) {
    for (const [fromState, , toState] of transitions) {
      if (fromState !== pendingStates[index] || reachedStates.has(toState)) continue;
      reachedStates.add(toState);
      pendingStates.push(toState);
    }
  }
  return states.filter((state) => !reachedStates.has(state));
}

function isUiFileName(fileName: string): boolean {
  return fileName.toLowerCase().split(".").slice(1).some((extension) => UI_FILE_EXTENSIONS.has(extension));
}

function directoryHoldsUiFile(directory: string): boolean {
  const pendingDirectories = [directory];
  for (let index = 0; index < pendingDirectories.length; index++) {
    for (const entry of fs.readdirSync(pendingDirectories[index], { withFileTypes: true })) {
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) pendingDirectories.push(path.join(pendingDirectories[index], entry.name));
      if (entry.isFile() && isUiFileName(entry.name)) return true;
    }
  }
  return false;
}

function changesUiPath(repoRoot: string, changedPath: string): boolean {
  const trimmedPath = changedPath.trim().replace(/[\\/]+$/, "");
  if (isUiFileName(path.basename(trimmedPath))) return true;
  const resolvedPath = path.resolve(repoRoot, trimmedPath);
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) return false;
  return directoryHoldsUiFile(resolvedPath);
}

function validateMockupBoard(value: Record<string, unknown>, subject: string, errors: string[]): void {
  const boardSubject = `${subject}.board`;
  if (value.layer !== "behavior") addError(errors, 1, boardSubject, "remove board, which only a behavior layer design carries");
  const board = value.board;
  if (!isRecord(board)) {
    addError(errors, 1, boardSubject, "supply board as { id, boxes, pages }");
    return;
  }
  rejectUnknownFields(board, ["id", "boxes", "pages"], boardSubject, errors);
  requireString(board.id, `${boardSubject}.id`, errors);
  for (const listField of ["boxes", "pages"] as const) {
    const entries = board[listField];
    if (!Array.isArray(entries) || entries.length === 0) {
      addError(errors, 1, `${boardSubject}.${listField}`, `supply ${listField} as a non-empty array of strings`);
      continue;
    }
    entries.forEach((entry: unknown, entryIndex: number) => requireString(entry, `${boardSubject}.${listField}[${entryIndex}]`, errors));
  }
  if (!Array.isArray(board.pages)) return;
  for (const [pageIndex, page] of board.pages.entries()) {
    if (typeof page !== "string") continue;
    const isHtmlFile = path.isAbsolute(page) && page.endsWith(".html") && fs.existsSync(page);
    if (!isHtmlFile) addError(errors, 1, `${boardSubject}.pages[${pageIndex}]`, `save the mockup as an absolute path to an existing .html file beside the spec, not an image or SVG (got ${page})`);
  }
}

function validateMachineShape(value: Record<string, unknown>, subject: string, errors: string[]): void {
  if (!Object.hasOwn(value, "at")) addError(errors, 1, `${subject}.at`, "supply at, the one module that owns writes to this machine");
  if (Object.hasOwn(value, "code")) requireString(value.code, `${subject}.code`, errors);
  const states = value.states;
  if (!isStringList(states) || states.length < 2 || new Set(states).size !== states.length) {
    addError(errors, 1, `${subject}.states`, "supply 2 or more distinct state names, the initial state first");
    return;
  }
  const transitions = value.transitions;
  const isTransitionList = Array.isArray(transitions) && transitions.length > 0 && transitions.every((transition) => isStringList(transition) && transition.length === 3);
  if (!isTransitionList) {
    addError(errors, 1, `${subject}.transitions`, "supply 1 or more [from, event, to] triples of non-empty strings");
    return;
  }
  const declaredStates = new Set(states);
  const undeclaredStates = [...new Set(transitions.flatMap(([fromState, , toState]) => [fromState, toState]).filter((state) => !declaredStates.has(state)))];
  if (undeclaredStates.length > 0) {
    addError(errors, 1, `${subject}.transitions`, `declare ${undeclaredStates.join(", ")} in states or fix the transitions naming them`);
    return;
  }
  const unreachableStates = listUnreachableStates(states, transitions as [string, string, string][]);
  if (unreachableStates.length > 0) {
    addError(errors, 1, `${subject}.transitions`, `add a transition reaching ${unreachableStates.join(", ")} from ${states[0]}, or drop the state`);
  }
}

export function machineText(design: Design): string {
  const transitionLines = (design.transitions ?? []).map(([fromState, event, toState]) => `${fromState} --${event}--> ${toState}`);
  return [`owner: ${design.at ?? ""}`, `states: ${(design.states ?? []).join(", ")}`, ...transitionLines, ...(design.code ? [design.code] : [])].join("\n");
}

function validateNodeShape(value: unknown, index: number, errors: string[], commitsCited: Set<string> | undefined): void {
  const subject = isRecord(value) && typeof value.id === "string" ? `node ${value.id}` : `node[${index}]`;
  if (!isRecord(value)) {
    addError(errors, 1, subject, "supply a node object");
    return;
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !Object.hasOwn(NODE_FIELDS, kind)) {
    addError(errors, 1, subject, "set kind to goal, nonGoal, branch, decision, openQuestion, unit, or design");
    return;
  }
  const nodeKind = kind as Node["kind"];
  rejectUnknownFields(value, NODE_FIELDS[nodeKind], subject, errors);
  if (typeof value.id !== "string" || !NODE_ID_PATTERNS[nodeKind].test(value.id)) {
    addError(errors, 2, subject, `use ${nodeKind === "goal" ? "G1" : `${NODE_ID_PATTERNS[nodeKind].source[1]}<positive integer>`} for a ${nodeKind} id`);
  }
  for (const field of NODE_FIELDS[nodeKind]) {
    if (["id", "kind", "reads", "changes", "checks", "serves", "evidence", "isConstraint", "budgetWaiver", "splits", "risk", "criteria", "layer", "at", "upstream", "problem", "lifecycle", "mockup", "code", "states", "transitions", "board"].includes(field)) continue;
    requireString(value[field], `${subject}.${field}`, errors);
  }
  if (nodeKind === "goal") {
    if (Object.hasOwn(value, "risk") && !["low", "medium", "high", "critical"].includes(value.risk as string)) {
      addError(errors, 1, `${subject}.risk`, "set risk to low, medium, high, or critical, or omit it");
    }
    const isGoalUpstreamCited = typeof value.upstream === "string" && citesSource(value.upstream, commitsCited, true);
    if (Object.hasOwn(value, "upstream") && !isGoalUpstreamCited) addError(errors, 1, `${subject}.upstream`, `say what simplest trigger and source one level up would remove the most branches and cite what you read (${CITATION_FORMS}), or write 'none: <why nothing sits above this feature>'`);
    if (Object.hasOwn(value, "problem")) requireString(value.problem, `${subject}.problem`, errors);
    if (!Object.hasOwn(value, "criteria")) return;
    if (!Array.isArray(value.criteria) || value.criteria.length < 1 || value.criteria.length > 12) {
      addError(errors, 1, `${subject}.criteria`, "supply an array of 1 to 12 non-empty strings or omit it");
      return;
    }
    value.criteria.forEach((criterion: unknown, criterionIndex: number) => requireString(criterion, `${subject}.criteria[${criterionIndex}]`, errors));
    return;
  }
  if (nodeKind === "decision") {
    if (!["decided", "read", "assumed"].includes(String(value.source))) {
      addError(errors, 1, subject, "set source to decided, read, or assumed");
    }
    if (Object.hasOwn(value, "isConstraint") && typeof value.isConstraint !== "boolean") {
      addError(errors, 1, subject, "set isConstraint to a boolean or omit it");
    }
    if (Object.hasOwn(value, "lifecycle") && value.lifecycle !== "none") {
      addError(errors, 1, `${subject}.lifecycle`, "set lifecycle to none, on a decision saying why the feature adds or changes no lifecycle, or omit it");
    }
    if (Object.hasOwn(value, "mockup") && value.mockup !== "none") {
      addError(errors, 1, `${subject}.mockup`, "set mockup to none, on a decision saying why a UI change has no board mockup, or omit it");
    }
    const evidence = typeof value.evidence === "string" ? value.evidence : "";
    const isEvidenceCited = /^\S(?:.*\S)?:[1-9]\d*$/.test(evidence) || citesSource(evidence, commitsCited, false);
    if (value.source === "read" && !isEvidenceCited) addError(errors, 1, `${subject}.evidence`, `cite what you read for a read decision: ${CITATION_FORMS}`);
    if (value.source === "assumed" && !isEvidenceCited) addError(errors, 1, `${subject}.evidence`, `research before assuming: find an outside source with WebSearch, read it with WebFetch (load both through ToolSearch where they are deferred), and cite ${CITATION_FORMS}`);
    return;
  }
  if (nodeKind === "branch") {
    const upstream = typeof value.upstream === "string" ? value.upstream : "";
    if (citesSource(upstream, commitsCited, true)) return;
    addError(errors, 1, `${subject}.upstream`, `say what one level up would make this question unnecessary and cite what you read (${CITATION_FORMS}), or write 'none: <why nothing sits above this choice>'`);
    return;
  }
  if (nodeKind === "design") {
    if (!["behavior", "architecture", "program", "machine"].includes(value.layer as string)) {
      addError(errors, 1, `${subject}.layer`, "set layer to behavior, architecture, program, or machine");
    }
    if (Object.hasOwn(value, "at")) requireString(value.at, `${subject}.at`, errors);
    if (value.layer === "program" && !Object.hasOwn(value, "at")) addError(errors, 1, `${subject}.at`, "supply at, the path a program design lands in");
    if (Object.hasOwn(value, "board")) validateMockupBoard(value, subject, errors);
    if (value.layer === "machine") {
      validateMachineShape(value, subject, errors);
      return;
    }
    requireString(value.code, `${subject}.code`, errors);
    for (const machineField of ["states", "transitions"]) {
      if (Object.hasOwn(value, machineField)) addError(errors, 1, `${subject}.${machineField}`, `remove ${machineField}, which only a machine layer design carries`);
    }
    return;
  }
  if (nodeKind !== "unit") return;
  if (typeof value.title === "string" && value.title.length > UNIT_TITLE_LIMIT) {
    addError(errors, 1, `${subject}.title`, `shorten the title to ${UNIT_TITLE_LIMIT} characters (has ${value.title.length}); a challenge bound belongs in the hand off`);
  }
  for (const field of ["reads", "changes"] as const) {
    const paths = value[field];
    if (!Array.isArray(paths)) {
      addError(errors, 1, subject, `supply ${field} as an array of paths`);
      continue;
    }
    paths.forEach((entry: unknown, pathIndex: number) => requireString(entry, `${subject}.${field}[${pathIndex}]`, errors));
  }
  if (Object.hasOwn(value, "budgetWaiver")) requireString(value.budgetWaiver, `${subject}.budgetWaiver`, errors);
  if (Object.hasOwn(value, "splits")) requireString(value.splits, `${subject}.splits`, errors);
  if (Object.hasOwn(value, "serves") && (!Array.isArray(value.serves) || !value.serves.every((criterionNumber: unknown) => Number.isInteger(criterionNumber) && Number(criterionNumber) >= 1))) {
    addError(errors, 1, `${subject}.serves`, "supply serves as an array of goal criterion numbers starting at 1, or omit it");
  }
  if (!Array.isArray(value.checks)) {
    addError(errors, 1, subject, "supply checks as an array of { run: string } objects");
    return;
  }
  value.checks.forEach((check: unknown, checkIndex: number) => {
    const checkSubject = `${subject}.checks[${checkIndex}]`;
    if (!isRecord(check)) {
      addError(errors, 1, checkSubject, "supply a { run: string } object");
      return;
    }
    rejectUnknownFields(check, ["run"], checkSubject, errors);
    requireString(check.run, `${checkSubject}.run`, errors);
  });
}

function validateShape(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    addError(errors, 1, "spec", "supply a DesignSpec object");
    return errors;
  }
  rejectUnknownFields(value, ["status", "request", "repoRoot", "nodes", "edges", "challengeStamp", "challengedUnitIds", "reviewGate"], "spec", errors);
  if (Object.hasOwn(value, "reviewGate") && !(REVIEW_GATES as readonly unknown[]).includes(value.reviewGate)) {
    addError(errors, 1, "spec.reviewGate", `use one of ${REVIEW_GATES.join(", ")}`);
  }
  if (typeof value.status !== "string" || !["sketch", "grilled", "sliced", "challenged"].includes(value.status)) {
    addError(errors, 1, "spec.status", "use sketch, grilled, sliced, or challenged");
  }
  requireString(value.request, "spec.request", errors);
  requireString(value.repoRoot, "spec.repoRoot", errors);
  if (Object.hasOwn(value, "challengeStamp")) requireString(value.challengeStamp, "spec.challengeStamp", errors);
  if (Object.hasOwn(value, "challengedUnitIds") && !Array.isArray(value.challengedUnitIds)) addError(errors, 1, "spec.challengedUnitIds", "supply an array of unit ids");
  if (Array.isArray(value.challengedUnitIds)) {
    value.challengedUnitIds.forEach((unitId: unknown, index: number) => requireString(unitId, `spec.challengedUnitIds[${index}]`, errors));
  }
  if (!Array.isArray(value.nodes)) addError(errors, 1, "spec.nodes", "supply an array of nodes");
  if (Array.isArray(value.nodes)) {
    const commitsCited = readCommitsCited(value.nodes, value.repoRoot);
    value.nodes.forEach((node: unknown, index: number) => validateNodeShape(node, index, errors, commitsCited));
  }
  if (!Array.isArray(value.edges)) addError(errors, 1, "spec.edges", "supply an array of edges");
  if (!Array.isArray(value.edges)) return errors;
  value.edges.forEach((edge: unknown, index: number) => {
    const subject = `edge[${index}]`;
    if (!isRecord(edge)) {
      addError(errors, 1, subject, "supply an edge object");
      return;
    }
    rejectUnknownFields(edge, ["from", "kind", "to"], subject, errors);
    requireString(edge.from, `${subject}.from`, errors);
    requireString(edge.to, `${subject}.to`, errors);
    if (typeof edge.kind !== "string" || !Object.hasOwn(EDGE_ENDPOINT_KINDS, edge.kind)) {
      addError(errors, 1, subject, "set kind to blocks, implements, dependsOn, or deferredBy");
    }
  });
  return errors;
}

function edgeSubject(edge: Edge): string {
  return `edge ${edge.from} ${edge.kind} ${edge.to}`;
}

function validateAcyclic(edges: Edge[], kind: "dependsOn" | "blocks", errors: string[]): void {
  const edgesByFrom = new Map<string, Edge[]>();
  for (const edge of edges) {
    if (edge.kind !== kind) continue;
    const outgoingEdges = edgesByFrom.get(edge.from) ?? [];
    outgoingEdges.push(edge);
    edgesByFrom.set(edge.from, outgoingEdges);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visited.has(id)) return;
    visiting.add(id);
    for (const edge of edgesByFrom.get(id) ?? []) {
      if (visiting.has(edge.to)) {
        addError(errors, 4, edgeSubject(edge), `remove or redirect this edge to break the ${kind} cycle`);
        continue;
      }
      visit(edge.to);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of edgesByFrom.keys()) visit(id);
}

function staysInside(root: string, target: string): boolean {
  const relativePath = path.relative(root, target);
  return relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

function isRelativeRepoPath(repoRoot: string, candidate: string): boolean {
  if (candidate !== candidate.trim()) return false;
  if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) return false;
  const normalizedCandidate = candidate.replace(/\\/g, "/");
  return staysInside(repoRoot, path.resolve(repoRoot, normalizedCandidate));
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && ["ENOENT", "ENOTDIR"].includes(String(error.code));
}

function failureCodeOf(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return String(error);
}

function resolveExistingPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    const parentPath = path.dirname(target);
    if (parentPath === target) return target;
    return path.join(resolveExistingPath(parentPath), path.basename(target));
  }
}

function resolveExistingDirectory(target: string): string | undefined {
  try {
    const resolvedTarget = fs.realpathSync(target);
    return fs.statSync(resolvedTarget).isDirectory() ? resolvedTarget : undefined;
  } catch {
    return undefined;
  }
}

function listedPathProblem(repoRoot: string, resolvedRoot: string | undefined, candidate: string, isRead: boolean, pathsOtherUnitsChange: string[]): string | undefined {
  if (!isRelativeRepoPath(repoRoot, candidate)) return `replace path ${candidate} with a relative path inside repoRoot`;
  if (resolvedRoot === undefined) return undefined;
  const listedPath = path.resolve(repoRoot, candidate);
  let resolvedPath: string;
  try {
    resolvedPath = resolveExistingPath(listedPath);
  } catch (error) {
    return `path ${candidate} cannot be resolved (${failureCodeOf(error)}); replace it with a readable path inside the repo`;
  }
  if (!staysInside(resolvedRoot, resolvedPath)) return `path ${candidate} resolves outside repoRoot; replace it with a path inside the repo`;
  if (!isRead || fs.existsSync(resolvedPath)) return undefined;
  if (pathsOtherUnitsChange.some((changedPath) => staysInside(changedPath, listedPath))) return undefined;
  return `reads path ${candidate} is missing under repoRoot; correct it, or list it under the changes of another unit that creates it`;
}

export function listPathWithAncestors(targetPath: string): string[] {
  const parentPath = path.dirname(targetPath);
  if (parentPath === targetPath) return [targetPath];
  return [targetPath, ...listPathWithAncestors(parentPath)];
}

function unitPairKey(unitId: string, otherUnitId: string): string {
  return JSON.stringify([unitId, otherUnitId].sort());
}

function findSharedRepoPathsByUnitPair(rootPath: string, changedPathsById: Map<string, string[]>): Map<string, string> {
  const unitIdsByChangedPath = new Map<string, Set<string>>();
  for (const [unitId, changedPaths] of changedPathsById) {
    for (const changedPath of changedPaths) {
      const unitIds = unitIdsByChangedPath.get(changedPath) ?? new Set<string>();
      unitIds.add(unitId);
      unitIdsByChangedPath.set(changedPath, unitIds);
    }
  }
  const sharedRepoPathsByUnitPair = new Map<string, string>();
  for (const [unitId, changedPaths] of changedPathsById) {
    for (const changedPath of changedPaths) {
      for (const containingPath of listPathWithAncestors(changedPath)) {
        for (const otherUnitId of unitIdsByChangedPath.get(containingPath) ?? []) {
          const unitPair = unitPairKey(unitId, otherUnitId);
          if (otherUnitId === unitId || sharedRepoPathsByUnitPair.has(unitPair)) continue;
          sharedRepoPathsByUnitPair.set(unitPair, path.relative(rootPath, changedPath) || ".");
        }
      }
    }
  }
  return sharedRepoPathsByUnitPair;
}

type ReadingMeasurement = { totalBytes: number; unmeasurablePaths: string[]; hasUncountedPaths: boolean };

const BINARY_SNIFF_BYTES = 8000;
const WIDE_TEXT_BYTE_ORDER_MARKS = [
  Buffer.from([0x00, 0x00, 0xfe, 0xff]),
  Buffer.from([0xff, 0xfe]),
  Buffer.from([0xfe, 0xff]),
];

function isBinaryFile(filePath: string): boolean {
  const fileDescriptor = fs.openSync(filePath, "r");
  try {
    const leadingBytes = Buffer.alloc(BINARY_SNIFF_BYTES);
    const bytesRead = fs.readSync(fileDescriptor, leadingBytes, 0, BINARY_SNIFF_BYTES, 0);
    const sniffedBytes = leadingBytes.subarray(0, bytesRead);
    const startsWithWideTextMark = WIDE_TEXT_BYTE_ORDER_MARKS.some((byteOrderMark) => sniffedBytes.subarray(0, byteOrderMark.length).equals(byteOrderMark));
    return !startsWithWideTextMark && sniffedBytes.includes(0);
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

function measureReadingBytes(resolvedRoot: string, listedPaths: string[], stopAboveBytes: number): ReadingMeasurement {
  const visitedPaths = new Set<string>();
  const unmeasurablePaths: string[] = [];
  let totalBytes = 0;
  let hasUncountedPaths = false;
  function measure(target: string): void {
    if (totalBytes > stopAboveBytes) {
      hasUncountedPaths = true;
      return;
    }
    try {
      const resolvedTarget = fs.realpathSync(target);
      if (!staysInside(resolvedRoot, resolvedTarget) || visitedPaths.has(resolvedTarget)) return;
      visitedPaths.add(resolvedTarget);
      const fileStatus = fs.statSync(resolvedTarget);
      if (fileStatus.isFile()) {
        if (!isBinaryFile(resolvedTarget)) totalBytes += fileStatus.size;
        return;
      }
      if (!fileStatus.isDirectory()) return;
      for (const entry of fs.readdirSync(resolvedTarget)) {
        if (entry !== ".git" && entry !== "node_modules") measure(path.join(resolvedTarget, entry));
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        hasUncountedPaths = true;
        return;
      }
      unmeasurablePaths.push(`${target} (${failureCodeOf(error)})`);
    }
  }
  for (const listedPath of new Set(listedPaths)) measure(listedPath);
  return { totalBytes, unmeasurablePaths, hasUncountedPaths };
}

function validateChallengeStamp(spec: DesignSpec, units: Unit[], errors: string[]): void {
  if (spec.status !== "challenged") {
    if (spec.challengeStamp !== undefined) addError(errors, 7, "spec.challengeStamp", "omit challengeStamp until status is challenged");
    if (spec.challengedUnitIds !== undefined) addError(errors, 7, "spec.challengedUnitIds", "omit challengedUnitIds until status is challenged");
    return;
  }
  if (!spec.challengeStamp || !CHALLENGE_STAMP_PATTERN.test(spec.challengeStamp)) {
    addError(errors, 7, "spec.challengeStamp", "supply CHALLENGE: <n> kept, <n> shrunk, <n> cut for challenged status");
  }
  if (spec.challengedUnitIds === undefined) {
    addError(errors, 7, "spec.challengedUnitIds", "supply the ids of the units without a deferredBy edge that the challenge judged");
    return;
  }
  const deferredUnitIds = new Set<string>(spec.edges.filter((edge) => edge.kind === "deferredBy").map((edge) => edge.from));
  const readyUnitIds: string[] = units.filter((unit) => !deferredUnitIds.has(unit.id)).map((unit) => unit.id);
  const challengedUnitIds = new Set(spec.challengedUnitIds);
  if (spec.challengedUnitIds.length === readyUnitIds.length && readyUnitIds.every((unitId) => challengedUnitIds.has(unitId))) return;
  addError(
    errors,
    7,
    "spec.challengedUnitIds",
    `the challenge judged ${spec.challengedUnitIds.join(", ") || "zero units"} while the units without a deferredBy edge are ${readyUnitIds.join(", ") || "none"}; set status back to sketch, grilled, or sliced and remove challengeStamp and challengedUnitIds before changing units`,
  );
}

function isSplitWellFormed(splitPath: string, readPaths: string[], changedPaths: string[], subject: string, errors: string[]): boolean {
  if (!readPaths.includes(splitPath) || !changedPaths.includes(splitPath)) {
    addError(errors, 13, subject, `list the splits path in both reads and changes, or remove splits`);
    return false;
  }
  if (changedPaths.some((changedPath) => changedPath !== splitPath)) return true;
  addError(errors, 13, subject, `add the file the split moves blocks into to changes, or remove splits`);
  return false;
}

export function validateGraph(value: unknown): string[] {
  const errors = validateShape(value);
  if (errors.length > 0) return errors;
  const spec = value as DesignSpec;
  const nodesById = new Map<string, Node>();
  for (const node of spec.nodes) {
    if (nodesById.has(node.id)) addError(errors, 2, `node ${node.id}`, "give each node a unique id");
    nodesById.set(node.id, node);
  }
  if (spec.nodes.filter((node) => node.kind === "goal").length !== 1) addError(errors, 2, "node G1", "include exactly one goal node");
  const seenEdges = new Set<string>();
  for (const edge of spec.edges) {
    const subject = edgeSubject(edge);
    const edgeKey = JSON.stringify([edge.from, edge.kind, edge.to]);
    if (seenEdges.has(edgeKey)) addError(errors, 3, subject, "remove the duplicate edge");
    seenEdges.add(edgeKey);
    if (edge.from === edge.to) addError(errors, 3, subject, "remove the self edge");
    const [fromKind, toKinds] = EDGE_ENDPOINT_KINDS[edge.kind];
    if (nodesById.get(edge.from)?.kind !== fromKind) addError(errors, 3, subject, `set from to an existing ${fromKind} node`);
    if (!(toKinds as Node["kind"][]).includes(nodesById.get(edge.to)?.kind as Node["kind"])) addError(errors, 3, subject, `set to to an existing ${toKinds.join(" or ")} node`);
  }
  validateAcyclic(spec.edges, "dependsOn", errors);
  validateAcyclic(spec.edges, "blocks", errors);
  const deferredIds = new Set<string>(spec.edges.filter((edge) => edge.kind === "deferredBy").map((edge) => edge.from));
  const dependentsById = new Map<string, string[]>();
  for (const edge of spec.edges) {
    if (edge.kind !== "dependsOn") continue;
    const dependents = dependentsById.get(edge.to) ?? [];
    dependents.push(edge.from);
    dependentsById.set(edge.to, dependents);
  }
  const pendingDeferredIds: string[] = [...deferredIds];
  for (let index = 0; index < pendingDeferredIds.length; index++) {
    for (const dependentId of dependentsById.get(pendingDeferredIds[index] ?? "") ?? []) {
      if (deferredIds.has(dependentId)) continue;
      deferredIds.add(dependentId);
      pendingDeferredIds.push(dependentId);
      addError(errors, 5, `node ${dependentId}`, "add a deferredBy edge because its dependency is deferred");
    }
  }
  const resolvedRoot = path.isAbsolute(spec.repoRoot) ? resolveExistingDirectory(spec.repoRoot) : undefined;
  if (resolvedRoot === undefined) addError(errors, 6, "spec.repoRoot", "supply the absolute path of an existing repository directory");
  const units = spec.nodes.filter((node): node is Unit => node.kind === "unit");
  for (const unit of units) {
    const pathsOtherUnitsChange = units
      .filter((otherUnit) => otherUnit.id !== unit.id)
      .flatMap((otherUnit) => otherUnit.changes.map((changedPath) => path.resolve(spec.repoRoot, changedPath)));
    for (const field of ["reads", "changes"] as const) {
      for (const candidate of unit[field]) {
        const problem = listedPathProblem(spec.repoRoot, resolvedRoot, candidate, field === "reads", pathsOtherUnitsChange);
        if (problem !== undefined) addError(errors, 6, `node ${unit.id}`, problem);
      }
    }
  }
  validateChallengeStamp(spec, units, errors);
  if (spec.status !== "sketch") {
    for (const node of spec.nodes) {
      if (node.kind === "branch") addError(errors, 8, `node ${node.id}`, "settle and remove this branch before grilled, sliced, or challenged status");
    }
  }
  const isSliced = spec.status === "sliced" || spec.status === "challenged";
  if (isSliced && units.length === 0) addError(errors, 9, "spec.nodes", "add at least one unit for sliced or challenged status");
  const implementedIds = new Set(spec.edges.filter((edge) => edge.kind === "implements").map((edge) => edge.to));
  const implementingIds = new Set(spec.edges.filter((edge) => edge.kind === "implements").map((edge) => edge.from));
  const goal = spec.nodes.find((node): node is Goal => node.kind === "goal");
  const goalCriteria = goal?.criteria ?? [];
  if (spec.status === "sketch" && goal !== undefined && goal.upstream === undefined) addError(errors, 1, "node G1.upstream", "write the goal's upstream at sketch, as sketch.md step 4 says");
  if (spec.status === "sketch" && goal !== undefined && goal.problem === undefined) addError(errors, 1, "node G1.problem", "write the problem the goal answers at sketch, as sketch.md step 4 says");
  const isGoalMissingCriteria = isSliced && goal !== undefined && goalCriteria.length === 0;
  if (isGoalMissingCriteria) addError(errors, 17, "node G1", "add criteria, 1 to 12 observable results; every unit serves one at sliced status");
  for (const unit of units) {
    if (!isSliced) continue;
    if (unit.changes.length === 0) addError(errors, 10, `node ${unit.id}`, "add at least one changes path");
    for (const [checkIndex, check] of unit.checks.entries()) {
      const normalizedCommand = check.run.replace(/[\t\r\n]/g, " ");
      if (/[;&|<>$`'"\x00-\x1f\x7f-\x9f]/.test(normalizedCommand)) {
        addError(errors, 14, `node ${unit.id}.checks[${checkIndex}].run`, "supply one command without shell operators, quotes, or control characters");
      }
      if (REPO_GATE_COMMAND.test(normalizedCommand.trim())) {
        addError(errors, 14, `node ${unit.id}.checks[${checkIndex}].run`, `drop ${oneLine(check.run)}: build.md already runs the repo typecheck, lint and tests; name a check specific to the unit or none`);
      }
    }
    for (const changedPath of unit.changes) {
      if (!/[*?\[\]]/.test(changedPath)) continue;
      addError(errors, 15, `node ${unit.id}`, `replace changes path ${changedPath} with a literal path without wildcards`);
    }
    if (!implementingIds.has(unit.id)) addError(errors, 11, `node ${unit.id}`, "add an implements edge to a decision");
    if (!isGoalMissingCriteria && (unit.serves ?? []).length === 0) addError(errors, 17, `node ${unit.id}`, "add serves naming the goal criteria this unit makes true; a unit serving none is a horizontal layer, so fold it into the vertical slice that needs it");
  }
  const servedCriterionNumbers = new Set(units.flatMap((unit) => unit.serves ?? []));
  for (const unit of units) {
    for (const criterionNumber of unit.serves ?? []) {
      if (isGoalMissingCriteria || criterionNumber <= goalCriteria.length) continue;
      addError(errors, 17, `node ${unit.id}`, `remove serves ${criterionNumber}; the goal has ${goalCriteria.length} criteria`);
    }
  }
  for (const [criterionIndex, criterion] of goalCriteria.entries()) {
    if (!isSliced || servedCriterionNumbers.has(criterionIndex + 1)) continue;
    addError(errors, 17, "node G1", `add ${criterionIndex + 1} to the serves of each unit that makes criterion ${criterionIndex + 1} true: ${criterion}`);
  }
  for (const node of spec.nodes) {
    if (!isSliced) continue;
    if (node.kind === "design" && !implementedIds.has(node.id)) addError(errors, 12, `node ${node.id}`, "add an implements edge from the unit that builds this design");
    if (node.kind !== "decision" || node.isConstraint === true || implementedIds.has(node.id)) continue;
    addError(errors, 12, `node ${node.id}`, "add an implements edge from a unit or mark the decision isConstraint: true");
  }
  const goalRisk = goal?.risk;
  const needsDesign = goalRisk !== "low";
  if (isSliced && needsDesign && !spec.nodes.some((node) => node.kind === "design")) {
    addError(errors, 18, "spec.nodes", `add design nodes from subskills/design.md; a spec settles its design before slicing unless its risk is low (risk is ${goalRisk ?? "unset"})`);
  }
  const hasMachine = spec.nodes.some((node) => node.kind === "design" && node.layer === "machine");
  const hasNoLifecycleDecision = spec.nodes.some((node) => node.kind === "decision" && node.lifecycle === "none");
  if (isSliced && needsDesign && !hasMachine && !hasNoLifecycleDecision) {
    addError(errors, 18, "spec.nodes", "add a design node with layer machine (states, transitions, at) for each lifecycle the feature adds or changes, or a decision with lifecycle: none saying why it adds or changes none");
  }
  const changesUi = isSliced && units.some((unit) => unit.changes.some((changedPath) => changesUiPath(spec.repoRoot, changedPath)));
  const hasBoardMockup = spec.nodes.some((node) => node.kind === "design" && node.layer === "behavior" && node.board !== undefined);
  const hasNoMockupDecision = spec.nodes.some((node) => node.kind === "decision" && node.mockup === "none");
  if (isSliced && changesUi && !hasBoardMockup && !hasNoMockupDecision) {
    addError(errors, 18, "spec.nodes", "add a behavior design with board { id, boxes, pages } holding the HTML mockups shown on the Glimmervoid whiteboard, as subskills/design.md says, or a decision with mockup: none saying why this UI change has none");
  }
  for (const machine of spec.nodes) {
    if (!isSliced || machine.kind !== "design" || machine.layer !== "machine" || machine.at === undefined) continue;
    const ownerPath = path.posix.normalize(machine.at.trim().replace(/\\/g, "/"));
    const builderIds = spec.edges.filter((edge) => edge.kind === "implements" && edge.to === machine.id).map((edge) => edge.from);
    const isOwnerChanged = units.some((unit) => builderIds.includes(unit.id) && unit.changes.some((changedPath) => path.posix.normalize(changedPath.trim().replace(/\\/g, "/")) === ownerPath));
    if (!isOwnerChanged) addError(errors, 12, `node ${machine.id}`, `list ${machine.at} in the changes of a unit implementing this machine; the owner is the one module that writes it`);
  }
  if (resolvedRoot === undefined || errors.some((error) => error.startsWith("Rule 6:"))) return errors;
  if (isSliced) {
    const resolvedChangedPathsById = new Map(units.map((unit) => [unit.id, unit.changes.map((candidate) => resolveExistingPath(path.resolve(spec.repoRoot, candidate)))]));
    const lexicalChangedPathsById = new Map(units.map((unit) => [unit.id, unit.changes.map((candidate) => path.resolve(spec.repoRoot, candidate.trim().replace(/\\/g, "/")))]));
    const reachableDependentsById = new Map<string, Set<string>>();
    for (const unit of units) {
      const reachableDependents = new Set<string>();
      const pendingIds: string[] = [unit.id];
      for (let index = 0; index < pendingIds.length; index++) {
        for (const dependentId of dependentsById.get(pendingIds[index]) ?? []) {
          if (reachableDependents.has(dependentId)) continue;
          reachableDependents.add(dependentId);
          pendingIds.push(dependentId);
        }
      }
      reachableDependentsById.set(unit.id, reachableDependents);
    }
    const resolvedSharedRepoPathsByUnitPair = findSharedRepoPathsByUnitPair(resolvedRoot, resolvedChangedPathsById);
    const lexicalSharedRepoPathsByUnitPair = findSharedRepoPathsByUnitPair(spec.repoRoot, lexicalChangedPathsById);
    for (const [unitIndex, unit] of units.entries()) {
      for (const otherUnit of units.slice(unitIndex + 1)) {
        if (reachableDependentsById.get(unit.id)?.has(otherUnit.id) || reachableDependentsById.get(otherUnit.id)?.has(unit.id)) continue;
        const unitPair = unitPairKey(unit.id, otherUnit.id);
        const sharedRepoPath = resolvedSharedRepoPathsByUnitPair.get(unitPair) ?? lexicalSharedRepoPathsByUnitPair.get(unitPair);
        if (sharedRepoPath === undefined) continue;
        addError(errors, 16, `node ${unit.id}`, `add a direct or transitive dependsOn path in either direction with ${otherUnit.id} to order changes sharing ${sharedRepoPath}`);
      }
    }
  }
  for (const unit of units) {
    if (!isSliced) continue;
    const isWaived = unit.budgetWaiver !== undefined;
    const changedPaths = unit.changes.map((candidate) => path.resolve(spec.repoRoot, candidate));
    const splitPath = unit.splits === undefined ? undefined : path.resolve(spec.repoRoot, unit.splits);
    const allReadPaths = unit.reads.map((candidate) => path.resolve(spec.repoRoot, candidate));
    if (splitPath !== undefined && !isSplitWellFormed(splitPath, allReadPaths, changedPaths, `node ${unit.id}`, errors)) continue;
    const readPaths = allReadPaths.filter((readPath) => readPath !== splitPath);
    const changedOnlyPaths = changedPaths.filter((changedPath) => !readPaths.some((readPath) => staysInside(readPath, changedPath)));
    const stopAboveBytes = isWaived ? READING_BUDGET_BYTES : Number.POSITIVE_INFINITY;
    const readMeasurement = measureReadingBytes(resolvedRoot, readPaths, stopAboveBytes);
    const changedOnlyMeasurements = [...new Set(changedOnlyPaths)].map((changedPath) => measureReadingBytes(resolvedRoot, [changedPath], stopAboveBytes));
    const allMeasurements = [readMeasurement, ...changedOnlyMeasurements];
    const totalBytes = changedOnlyMeasurements.reduce((runningBytes, measurement) => runningBytes + Math.min(measurement.totalBytes, CHANGED_ONLY_PATH_CAP_BYTES), readMeasurement.totalBytes);
    const unmeasurablePaths = allMeasurements.flatMap((measurement) => measurement.unmeasurablePaths);
    if (isWaived) {
      const isEveryPathCounted = unmeasurablePaths.length === 0 && allMeasurements.every((measurement) => !measurement.hasUncountedPaths);
      if (isEveryPathCounted && totalBytes <= READING_BUDGET_BYTES) addError(errors, 13, `node ${unit.id}`, `drop budgetWaiver: reads plus capped changes total ${totalBytes} bytes, within ${READING_BUDGET_BYTES} bytes`);
      continue;
    }
    for (const unmeasurablePath of unmeasurablePaths) {
      addError(errors, 13, `node ${unit.id}`, `path ${unmeasurablePath} cannot be measured; narrow reads and changes to readable paths or supply budgetWaiver`);
    }
    if (totalBytes <= READING_BUDGET_BYTES) continue;
    addError(errors, 13, `node ${unit.id}`, `reads plus capped changes total ${totalBytes} bytes above ${READING_BUDGET_BYTES} bytes; narrow the paths or supply budgetWaiver`);
  }
  return errors;
}
