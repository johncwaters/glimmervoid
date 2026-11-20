import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Git } from "./git.ts";

export const REVIEW_GATES = ["gating-reviews"] as const;
const LEDGER_REVIEW_GATES: readonly string[] = [...REVIEW_GATES, "converging-reviews"];

export const STAMP_GATES = [...REVIEW_GATES, "releasing", "coherence-journal"] as const;

export type StampGate = (typeof STAMP_GATES)[number];

export type StampFinding = { severity: string; file: string; summary: string };

export type StampFindings = {
  liveFindings: StampFinding[];
  unverifiedFindings: StampFinding[];
  preexistingFailures: string[];
  truncatedLanes: string[];
  droppedUnproven: number;
};

export type StampRow = StampFindings & {
  v: 1;
  at: string;
  gate: StampGate;
  head: string | null;
  tree: string;
  paths: string[];
  prefix?: string;
  uiEvidence?: string;
};

export type UiEvidence = { kind: "report"; file: string } | { kind: "waived"; reason: string } | { kind: "none" };

export type StampVerification =
  | { matches: true; stamp: StampRow }
  | { matches: false; stamp: StampRow | null; tree: string | null };

const UI_FILE_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less", ".html", ".tsx", ".jsx", ".vue", ".svelte", ".astro"]);
const SCREENSHOT_EXTENSIONS = new Set([".png"]);
const REPORT_EXTENSIONS = new Set([".json"]);

const BLOCKING_SEVERITIES = new Set(["MEDIUM", "HIGH", "CRITICAL"]);
const KNOWN_SEVERITIES = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
const FINDING_LIST_KEYS = ["liveFindings", "unverifiedFindings"] as const;
const STRING_LIST_KEYS = ["preexistingFailures", "truncatedLanes"] as const;

export const EMPTY_FINDINGS: StampFindings = {
  liveFindings: [],
  unverifiedFindings: [],
  preexistingFailures: [],
  truncatedLanes: [],
  droppedUnproven: 0,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFinding(raw: unknown, where: string): StampFinding {
  if (!isPlainObject(raw) || typeof raw.file !== "string" || typeof raw.summary !== "string" || typeof raw.severity !== "string") {
    throw new Error(`${where} needs string severity, file, and summary`);
  }
  const severity = raw.severity.toUpperCase();
  if (!KNOWN_SEVERITIES.has(severity)) {
    throw new Error(`${where} has unknown severity ${raw.severity}`);
  }
  return { severity, file: raw.file, summary: raw.summary };
}

export function parseStampFindings(raw: unknown): StampFindings {
  if (!isPlainObject(raw)) {
    throw new Error("findings must be a JSON object");
  }
  const knownKeys = new Set<string>([...FINDING_LIST_KEYS, ...STRING_LIST_KEYS, "droppedUnproven"]);
  const unknownKeys = Object.keys(raw).filter((key) => !knownKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`unknown findings keys: ${unknownKeys.join(", ")}`);
  }
  const findings: StampFindings = { ...EMPTY_FINDINGS };
  for (const key of FINDING_LIST_KEYS) {
    const list = raw[key] ?? [];
    if (!Array.isArray(list)) {
      throw new Error(`${key} must be a list`);
    }
    findings[key] = list.map((finding, index) => parseFinding(finding, `${key}[${index}]`));
  }
  for (const key of STRING_LIST_KEYS) {
    const list = raw[key] ?? [];
    if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string")) {
      throw new Error(`${key} must be a list of strings`);
    }
    findings[key] = list;
  }
  const droppedUnproven = raw.droppedUnproven ?? 0;
  if (typeof droppedUnproven !== "number") {
    throw new Error("droppedUnproven must be a number");
  }
  findings.droppedUnproven = droppedUnproven;
  return findings;
}

function isReviewGate(gate: string): boolean {
  return (REVIEW_GATES as readonly string[]).includes(gate);
}

export function isStampGate(value: string): value is StampGate {
  return (STAMP_GATES as readonly string[]).includes(value);
}

export function gateToRerun(stamp: StampRow | null): string {
  const lastGate = stamp?.gate ?? "";
  return (REVIEW_GATES as readonly string[]).includes(lastGate) ? lastGate : "gating-reviews";
}

export function stampLedgerPath(git: Git): string {
  const commonDirectory = path.resolve(git.repo, git.commonDir());
  const baseDirectory = process.env.REVIEW_GATES_DIR || path.join(commonDirectory, "ship", "review-gates");
  const mainCheckoutPath = path.dirname(commonDirectory);
  const mainCheckoutName = `${path.basename(mainCheckoutPath)}-${createHash("sha1").update(mainCheckoutPath).digest("hex").slice(0, 12)}`;
  const headRef = git.run(["symbolic-ref", "-q", "HEAD"]).stdout.trim();
  const branchFileName = encodeURIComponent(headRef.replace(/^refs\/heads\//, "") || "HEAD");
  return path.join(baseDirectory, mainCheckoutName, `${branchFileName}.jsonl`);
}

export function pinScopedTree(git: Git, paths: string[]): string | null {
  const scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "landing-stamp-"));
  try {
    return git.scopedTreeOid(path.join(scratchDirectory, "index"), paths);
  } finally {
    fs.rmSync(scratchDirectory, { recursive: true, force: true });
  }
}

export function changedPathsOutside(git: Git, allowedPaths: string[]): string[] | null {
  const prefix = git.run(["rev-parse", "--show-prefix"]);
  const status = git.run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ":/"]);
  if (prefix.code !== 0 || status.code !== 0) {
    return null;
  }
  const allowedRootPaths = allowedPaths.map((allowedPath) => path.posix.normalize(path.posix.join(prefix.stdout.trim(), allowedPath)).replace(/\/+$/, ""));
  const isAllowed = (changedPath: string) => allowedRootPaths.some((allowedPath) => changedPath === allowedPath || changedPath.startsWith(`${allowedPath}/`));
  const changedPaths = status.stdout.split("\0").filter(Boolean).map((entry) => (/^[ MADRCU?!]{2} /.test(entry) ? entry.slice(3) : entry));
  return changedPaths.filter((changedPath) => !isAllowed(changedPath));
}

export function uiEvidenceFromFlags(reportFile: string | undefined, waiverReason: string | undefined): UiEvidence | string {
  if (reportFile !== undefined && waiverReason !== undefined) return "pass --ui-evidence or --no-ui-evidence, not both";
  if (waiverReason !== undefined) return waiverReason.trim() === "" ? "--no-ui-evidence needs a reason" : { kind: "waived", reason: waiverReason.trim() };
  if (reportFile !== undefined) return reportFile === "" ? "--ui-evidence needs the layout-shift report path" : { kind: "report", file: path.resolve(reportFile) };
  return { kind: "none" };
}

function changedPathsMatching(git: Git, pathspecs: string[]): string[] {
  const status = git.run(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", ...pathspecs]);
  if (status.code !== 0) throw new Error(`could not list the changed files under ${pathspecs.join(", ")}`);
  return status.stdout.split("\0").filter(Boolean).map((entry) => entry.slice(3));
}

function changedUiFiles(git: Git, paths: string[]): string[] {
  const repoRoot = git.run(["rev-parse", "--show-toplevel"]).stdout.trim();
  return changedPathsMatching(git, paths)
    .filter((changedPath) => UI_FILE_EXTENSIONS.has(path.posix.extname(changedPath).toLowerCase()))
    .map((changedPath) => path.join(repoRoot, changedPath));
}

function isResolvedPathInside(resolvedDirectory: string, resolvedPath: string): boolean {
  const relativeToDirectory = path.relative(resolvedDirectory, resolvedPath);
  return relativeToDirectory !== ".." && !relativeToDirectory.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToDirectory);
}

function isInsideDirectory(directory: string, existingFile: string): boolean {
  const resolvedDirectory = fs.realpathSync(directory);
  const entryLocation = path.join(fs.realpathSync(path.dirname(existingFile)), path.basename(existingFile));
  return isResolvedPathInside(resolvedDirectory, entryLocation) || isResolvedPathInside(resolvedDirectory, fs.realpathSync(existingFile));
}

function evidenceFileRefusal(repoRoot: string, evidenceFile: string, uiFiles: string[], allowedExtensions: Set<string>): string | null {
  if (!fs.existsSync(evidenceFile)) return `${evidenceFile} does not exist`;
  if (isInsideDirectory(repoRoot, evidenceFile)) return `${evidenceFile} is inside the checkout, which moves the reviewed tree; save it outside, under mktemp -d`;
  if (!allowedExtensions.has(path.extname(evidenceFile).toLowerCase())) return `${evidenceFile} is not a ${[...allowedExtensions].join(" ")} file`;
  const remainingUiFiles = uiFiles.filter((uiFile) => fs.existsSync(uiFile));
  if (remainingUiFiles.length === 0) return null;
  const newestUiEditMs = Math.max(...remainingUiFiles.map((uiFile) => fs.statSync(uiFile).mtimeMs));
  if (fs.statSync(evidenceFile).mtimeMs <= newestUiEditMs) return `${evidenceFile} is older than the last edit to the changed UI files`;
  return null;
}

function readLayoutShiftReport(reportFile: string): { shifts: unknown[]; screenshots: string[] } | null {
  try {
    const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
    const hasScreenshots = Array.isArray(report?.screenshots) && report.screenshots.length > 0 && report.screenshots.every((screenshot: unknown) => typeof screenshot === "string");
    return Array.isArray(report?.shifts) && hasScreenshots ? report : null;
  } catch {
    return null;
  }
}

function layoutShiftReportRefusal(repoRoot: string, reportFile: string, uiFiles: string[]): string | null {
  const reportFileRefusal = evidenceFileRefusal(repoRoot, reportFile, uiFiles, REPORT_EXTENSIONS);
  if (reportFileRefusal !== null) return reportFileRefusal;
  const report = readLayoutShiftReport(reportFile);
  if (report === null) return `${reportFile} is not a layout-shift.mjs --report file`;
  if (report.shifts.length > 0) return `${reportFile} records ${report.shifts.length} layout shifts; fix them and rerun`;
  const screenshotRefusals = report.screenshots.map((screenshot) => evidenceFileRefusal(repoRoot, path.resolve(path.dirname(reportFile), screenshot), uiFiles, SCREENSHOT_EXTENSIONS));
  return screenshotRefusals.find((refusal) => refusal !== null) ?? null;
}

function uiEvidenceOutcome(git: Git, paths: string[], uiEvidence: UiEvidence): { recordedEvidence?: string; waiverFindings: StampFinding[] } {
  const uiFiles = changedUiFiles(git, paths);
  if (uiFiles.length === 0) return { waiverFindings: [] };
  if (uiEvidence.kind === "waived") {
    return { waiverFindings: [{ severity: "LOW", file: path.relative(git.run(["rev-parse", "--show-toplevel"]).stdout.trim(), uiFiles[0] ?? ""), summary: `UI change not rendered: ${uiEvidence.reason}` }] };
  }
  if (uiEvidence.kind === "none") throw new UiEvidenceMissing("no --ui-evidence layout-shift report of the changed UI was named", uiFiles);
  const refusal = layoutShiftReportRefusal(git.run(["rev-parse", "--show-toplevel"]).stdout.trim(), uiEvidence.file, uiFiles);
  if (refusal !== null) throw new UiEvidenceMissing(refusal, uiFiles);
  return { recordedEvidence: uiEvidence.file, waiverFindings: [] };
}

function readStampRows(git: Git): StampRow[] {
  const ledgerFile = stampLedgerPath(git);
  if (!fs.existsSync(ledgerFile)) {
    return [];
  }
  return fs
    .readFileSync(ledgerFile, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as StampRow);
}

function landedLedgerPath(git: Git): string {
  return stampLedgerPath(git).replace(/\.jsonl$/, ".landed");
}

export function recordLandedCommit(git: Git, commit: string): void {
  const patchId = git.patchIdsByCommit(["-1", commit]).get(commit);
  if (patchId === undefined) {
    return;
  }
  const landedFile = landedLedgerPath(git);
  fs.mkdirSync(path.dirname(landedFile), { recursive: true });
  fs.appendFileSync(landedFile, `${patchId}\n`);
}

function readLandedEntries(git: Git): Set<string> {
  const landedFile = landedLedgerPath(git);
  return new Set(fs.existsSync(landedFile) ? fs.readFileSync(landedFile, "utf8").split("\n").filter(Boolean) : []);
}

type ClassifiedMerge = { commit: string; parents: string[]; remergeFiles: string[] | null };

function isFastForwardMerge(git: Git, merge: ClassifiedMerge, filePaths: string[]): boolean {
  const [firstParent = "", secondParent = ""] = merge.parents;
  const mergeBase = git.mergeBase(firstParent, secondParent);
  if (mergeBase === null) return false;
  const mergedEntries = git.treeEntriesByPath(merge.commit, filePaths);
  const firstParentEntries = git.treeEntriesByPath(firstParent, filePaths);
  const secondParentEntries = git.treeEntriesByPath(secondParent, filePaths);
  const firstParentHistory = git.treeEntriesInHistoryByPath(`${mergeBase}..${firstParent}`, filePaths);
  const secondParentHistory = git.treeEntriesInHistoryByPath(`${mergeBase}..${secondParent}`, filePaths);
  return filePaths.every((filePath) => {
    const mergedEntry = mergedEntries.get(filePath);
    const firstParentEntry = firstParentEntries.get(filePath);
    const secondParentEntry = secondParentEntries.get(filePath);
    if (mergedEntry === undefined || firstParentEntry === undefined || secondParentEntry === undefined) return false;
    if (mergedEntry === firstParentEntry) return firstParentHistory.get(filePath)?.has(secondParentEntry) ?? false;
    if (mergedEntry === secondParentEntry) return secondParentHistory.get(filePath)?.has(firstParentEntry) ?? false;
    return false;
  });
}

function needsReview(git: Git, merge: ClassifiedMerge): boolean {
  if (merge.remergeFiles === null || merge.parents.length > 2) return true;
  if (merge.remergeFiles.length === 0) return false;
  return !isFastForwardMerge(git, merge, merge.remergeFiles);
}

export function commitsNotLandedSince(git: Git, revisionArgs: string[]): string[] {
  const landedEntries = readLandedEntries(git);
  const unlandedCommits = new Set([...git.patchIdsByCommit(revisionArgs)].filter(([, patchId]) => !landedEntries.has(patchId)).map(([commit]) => commit));
  for (const merge of git.mergesWithRemergeFiles(revisionArgs)) {
    if (!landedEntries.has(merge.commit) && needsReview(git, merge)) unlandedCommits.add(merge.commit);
  }
  if (unlandedCommits.size === 0) return [];
  return git.revListNewestFirst(revisionArgs).filter((commit) => unlandedCommits.has(commit));
}

export class UiEvidenceMissing extends Error {
  readonly uiFiles: string[];

  constructor(reason: string, uiFiles: string[]) {
    super(`${reason}; changed UI files:\n${uiFiles.join("\n")}`);
    this.name = "UiEvidenceMissing";
    this.uiFiles = uiFiles;
  }
}

export function writeStamp(git: Git, gate: StampGate, paths: string[], findings: StampFindings, uiEvidence: UiEvidence = { kind: "none" }): StampRow {
  const tree = pinScopedTree(git, paths);
  if (tree === null) {
    throw new Error(`could not pin the tree over ${paths.join(", ")}`);
  }
  const { recordedEvidence, waiverFindings } = isReviewGate(gate) ? uiEvidenceOutcome(git, paths, uiEvidence) : { waiverFindings: [] };
  const preexistingFailures = [...findings.preexistingFailures];
  const prefix = git.run(["rev-parse", "--show-prefix"]).stdout.trim();
  const unverifiedFindings = [...findings.unverifiedFindings, ...waiverFindings];
  const row: StampRow = {
    v: 1,
    at: new Date().toISOString(),
    gate,
    head: git.revParseHead(),
    tree,
    paths,
    prefix,
    ...findings,
    unverifiedFindings,
    preexistingFailures,
    ...(recordedEvidence === undefined ? {} : { uiEvidence: recordedEvidence }),
  };
  const ledgerFile = stampLedgerPath(git);
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.appendFileSync(ledgerFile, `${JSON.stringify(row)}\n`);
  return row;
}

export function lastStamp(git: Git): StampRow | null {
  return readStampRows(git).at(-1) ?? null;
}

export function verifyStamp(git: Git): StampVerification {
  const stamp = lastStamp(git);
  if (stamp === null) {
    return { matches: false, stamp: null, tree: null };
  }
  const tree = pinScopedTree(git, stamp.paths);
  if (tree !== stamp.tree || stamp.head !== git.revParseHead()) {
    return { matches: false, stamp, tree };
  }
  return { matches: true, stamp };
}

function reviewCoversFile(stamp: StampRow, file: string): boolean {
  if (!LEDGER_REVIEW_GATES.includes(stamp.gate)) {
    return false;
  }
  return stamp.paths.some((stampPath) => {
    const coveredPath = path.posix.normalize(path.posix.join(stamp.prefix ?? "", stampPath)).replace(/\/+$/, "");
    return coveredPath === "." || file === coveredPath || file.startsWith(`${coveredPath}/`);
  });
}

export function branchBlockingFindings(git: Git): StampFinding[] {
  const pendingFindingsByFile = new Map<string, StampFinding[]>();
  for (const stamp of readStampRows(git)) {
    for (const file of pendingFindingsByFile.keys()) {
      if (reviewCoversFile(stamp, file)) {
        pendingFindingsByFile.delete(file);
      }
    }
    const blockingFindings = [...stamp.liveFindings, ...stamp.unverifiedFindings].filter((finding) => BLOCKING_SEVERITIES.has(finding.severity));
    for (const finding of blockingFindings) {
      pendingFindingsByFile.set(finding.file, [...(pendingFindingsByFile.get(finding.file) ?? []), finding]);
    }
  }
  return [...pendingFindingsByFile.values()].flat();
}

export function releaseBranch(git: Git, baseRef: string | null): void {
  fs.rmSync(stampLedgerPath(git), { force: true });
  const branchRevisionArgs = [baseRef === null ? "HEAD" : `${baseRef}..HEAD`];
  const branchPatchIds = [...git.patchIdsByCommit(branchRevisionArgs).values()];
  const branchMerges = git.revListNewestFirst(["--merges", ...branchRevisionArgs]);
  const landedEntries = [...branchPatchIds, ...branchMerges];
  if (landedEntries.length === 0) {
    return;
  }
  const landedFile = landedLedgerPath(git);
  fs.mkdirSync(path.dirname(landedFile), { recursive: true });
  fs.appendFileSync(landedFile, landedEntries.map((entry) => `${entry}\n`).join(""));
}

export function clearReviewStamps(git: Git): void {
  fs.rmSync(stampLedgerPath(git), { force: true });
}

export function clearStampLedger(git: Git): void {
  fs.rmSync(stampLedgerPath(git), { force: true });
  fs.rmSync(landedLedgerPath(git), { force: true });
}
