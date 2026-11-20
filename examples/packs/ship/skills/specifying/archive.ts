import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { specArchiveDirectory } from "./lib/spec-store.ts";
import { readTicketHistory } from "./lib/ticket-history.ts";

type ArchiveReport =
  | { outcome: "ARCHIVED"; specPath: string; intentPath: string | null }
  | { outcome: "REFUSED"; errors: string[] };

function findPreviousArchiveMs(archiveDirectory: string, slug: string): number | undefined {
  if (!fs.existsSync(archiveDirectory)) return undefined;
  const archiveTimes = fs.readdirSync(archiveDirectory)
    .filter((name) => name.match(/^(.+)\.(?:built|abandoned)\.\d{4}-\d{2}-\d{2}(?:\.\d+)?\.json$/)?.[1] === slug)
    .map((name) => fs.statSync(path.join(archiveDirectory, name)).mtimeMs);
  return archiveTimes.length === 0 ? undefined : Math.max(...archiveTimes);
}

function findUnlandedUnitErrors(spec: { repoRoot: string; nodes?: { id: string; kind: string }[] }, slug: string, sinceMs: number | undefined): string[] {
  const historyRead = readTicketHistory(spec.repoRoot, { sinceMs, isPushedOnly: true });
  if (historyRead.outcome === "UNREADABLE") return [`cannot read Ticket trailers in ${spec.repoRoot}: ${historyRead.reason}`];
  const landedUnitIds = historyRead.history.get(slug) ?? new Map<string, number[]>();
  return (spec.nodes ?? [])
    .filter((node) => node.kind === "unit" && !landedUnitIds.has(node.id))
    .map((unit) => `${unit.id}: no pushed commit carries trailer Ticket: ${slug}/${unit.id}; land it or archive abandoned`);
}

type SpecWithBoards = { nodes?: { board?: { pages?: string[] } }[] };

function withMockupPagesMoved<T extends SpecWithBoards>(spec: T, fromDirectory: string, toDirectory: string): T {
  const movePage = (page: string) => {
    const relativePage = path.relative(fromDirectory, path.resolve(page));
    const isInsideMockups = relativePage !== "" && !relativePage.startsWith("..") && !path.isAbsolute(relativePage);
    return isInsideMockups ? path.join(toDirectory, relativePage) : page;
  };
  const nodes = (spec.nodes ?? []).map((node) => node.board?.pages ? { ...node, board: { ...node.board, pages: node.board.pages.map(movePage) } } : node);
  return { ...spec, nodes };
}

export function archiveSpec(specArgument: string | undefined, outcome: string | undefined, now = new Date()): ArchiveReport {
  const errors: string[] = [];
  if (!specArgument?.endsWith(".json") || specArgument.endsWith(".intent.json")) {
    errors.push("spec path must end in .json and must not end in .intent.json");
  }
  if (outcome !== "built" && outcome !== "abandoned") errors.push("outcome must be built or abandoned");
  if (errors.length > 0) return { outcome: "REFUSED", errors };

  try {
    const specPath = path.resolve(specArgument!);
    const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
    if (typeof spec !== "object" || spec === null || typeof spec.repoRoot !== "string") {
      return { outcome: "REFUSED", errors: ["spec must contain a repoRoot string"] };
    }
    if (fs.existsSync(spec.repoRoot)) {
      const gitDirectory = spawnSync("git", ["-C", spec.repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
      if (gitDirectory.status === 0) spec.repoRoot = path.dirname(gitDirectory.stdout.trim());
    }

    const repo = path.basename(path.dirname(specPath));
    const slug = path.basename(specPath, ".json");
    const intentPath = path.join(path.dirname(specPath), `${slug}.intent.json`);
    const mockupsPath = path.join(path.dirname(specPath), `${slug}.mockups`);
    const intentBytes = fs.existsSync(intentPath) ? fs.readFileSync(intentPath) : null;
    const archiveDirectory = path.join(specArchiveDirectory(), repo);
    const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (outcome === "built") {
      if (intentBytes === null) return { outcome: "REFUSED", errors: [`built needs ${slug}.intent.json; cut the spec first or archive abandoned`] };
      const unlandedUnitErrors = findUnlandedUnitErrors(spec, slug, findPreviousArchiveMs(archiveDirectory, slug));
      if (unlandedUnitErrors.length > 0) return { outcome: "REFUSED", errors: unlandedUnitErrors };
    }
    fs.mkdirSync(archiveDirectory, { recursive: true });

    for (let sequence = 1; ; sequence += 1) {
      const suffix = sequence === 1 ? "" : `.${sequence}`;
      const archiveStem = `${slug}.${outcome}.${localDate}${suffix}`;
      const archivedSpecPath = path.join(archiveDirectory, `${archiveStem}.json`);
      const archivedIntentPath = path.join(archiveDirectory, `${archiveStem}.intent.json`);
      const archivedMockupsPath = path.join(archiveDirectory, `${archiveStem}.mockups`);
      if (fs.existsSync(archivedSpecPath) || fs.existsSync(archivedIntentPath) || fs.existsSync(archivedMockupsPath)) continue;
      const hasMockups = fs.existsSync(mockupsPath);
      const archivedSpec = hasMockups ? withMockupPagesMoved(spec, mockupsPath, archivedMockupsPath) : spec;

      if (hasMockups) fs.renameSync(mockupsPath, archivedMockupsPath);
      let hasWrittenSpec = false;
      try {
        fs.writeFileSync(archivedSpecPath, `${JSON.stringify(archivedSpec, null, 2)}\n`, { flag: "wx" });
        hasWrittenSpec = true;
        if (intentBytes !== null) fs.writeFileSync(archivedIntentPath, intentBytes, { flag: "wx" });
      } catch (error) {
        if (hasWrittenSpec) fs.unlinkSync(archivedSpecPath);
        if (hasMockups) fs.renameSync(archivedMockupsPath, mockupsPath);
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }

      fs.unlinkSync(specPath);
      if (intentBytes !== null) fs.unlinkSync(intentPath);
      return { outcome: "ARCHIVED", specPath: archivedSpecPath, intentPath: intentBytes === null ? null : archivedIntentPath };
    }
  } catch (error) {
    return { outcome: "REFUSED", errors: [error instanceof Error ? error.message : String(error)] };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const report = archiveSpec(process.argv[2], process.argv[3]);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.outcome === "ARCHIVED" ? 0 : 1;
}
