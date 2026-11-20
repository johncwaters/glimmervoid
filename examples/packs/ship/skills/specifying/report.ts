import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { archiveSpec } from "./archive.ts";
import type { DesignSpec } from "./lib/graph.ts";
import { specArchiveDirectory, specsDirectory } from "./lib/spec-store.ts";
import { readTicketHistory } from "./lib/ticket-history.ts";
import type { TicketHistory } from "./lib/ticket-history.ts";

type StoredSpec = { specPath: string; repo: string; spec: Partial<DesignSpec> };

function warn(message: string): void {
  process.stderr.write(`${message.replace(/[\r\n]+/g, " ")}\n`);
}

function readStoredSpecs(directory: string): StoredSpec[] {
  if (!fs.existsSync(directory)) return [];
  const specs: StoredSpec[] = [];
  for (const repo of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!repo.isDirectory()) continue;
    const repoDirectory = path.join(directory, repo.name);
    for (const entry of fs.readdirSync(repoDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.endsWith(".json") || entry.name.endsWith(".intent.json")) continue;
      const specPath = path.join(repoDirectory, entry.name);
      try {
        const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
        if (typeof spec !== "object" || spec === null) throw new Error("expected a spec object");
        specs.push({ specPath, repo: repo.name, spec });
      } catch (error) {
        warn(`Skipping ${specPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return specs;
}

export function reportSpecs(now = new Date()): void {
  const historyByRepoRoot = new Map<string, TicketHistory | undefined>();
  function readCachedTicketHistory(repoRoot: string | undefined): TicketHistory | undefined {
    if (typeof repoRoot !== "string" || repoRoot.trim() === "") return undefined;
    if (historyByRepoRoot.has(repoRoot)) return historyByRepoRoot.get(repoRoot);
    const historyRead = readTicketHistory(repoRoot);
    if (historyRead.outcome === "UNREADABLE") warn(`Cannot read ticket history for ${repoRoot}: ${historyRead.reason}`);
    const history = historyRead.outcome === "READ" ? historyRead.history : undefined;
    historyByRepoRoot.set(repoRoot, history);
    return history;
  }

  const staleBeforeMs = now.getTime() - 14 * 24 * 60 * 60 * 1000;
  for (const { specPath, spec } of readStoredSpecs(specsDirectory())) {
    if (typeof spec.repoRoot !== "string" || spec.repoRoot.trim() === "") {
      warn(`Skipping ${specPath}: missing repoRoot`);
      continue;
    }
    try {
      const specModifiedAtMs = fs.statSync(specPath).mtimeMs;
      if (specModifiedAtMs >= staleBeforeMs) continue;
      const intentPath = specPath.replace(/\.json$/, ".intent.json");
      if (fs.existsSync(intentPath) && fs.statSync(intentPath).mtimeMs >= staleBeforeMs) continue;
      const history = readCachedTicketHistory(spec.repoRoot);
      if (!history) continue;
      const slug = path.basename(specPath, ".json");
      if ([...(history.get(slug)?.values() ?? [])].flat().some((committedAtMs) => committedAtMs > specModifiedAtMs)) continue;
      const archiveReport = archiveSpec(specPath, "abandoned", now);
      if (archiveReport.outcome === "REFUSED") {
        warn(`Skipping ${specPath}: ${archiveReport.errors.join("; ")}`);
        continue;
      }
      warn(`Archived ${specPath} as abandoned: ${archiveReport.specPath}`);
    } catch (error) {
      warn(`Skipping ${specPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const archives = readStoredSpecs(specArchiveDirectory()).flatMap((storedSpec) => {
    const filename = path.basename(storedSpec.specPath).match(/^(.+)\.(built|abandoned)\.(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.json$/);
    if (!filename) return [];
    const [, slug, outcome, date, sequence = "1"] = filename;
    return [{ ...storedSpec, slug, outcome, date, sequence: Number(sequence) }];
  });
  archives.sort((first, second) => first.date.localeCompare(second.date) || first.sequence - second.sequence);
  const previousArchiveEndMsBySlugInRepo = new Map<string, number>();
  const rows: string[][] = [];
  for (const { repo, spec, slug, outcome, date } of archives) {
    const [year, month, day] = date.split("-").map(Number);
    const archiveDayEndMs = new Date(year, month - 1, day + 1).getTime();
    const slugInRepo = `${repo}/${slug}`;
    const windowStartMs = previousArchiveEndMsBySlugInRepo.get(slugInRepo) ?? -Infinity;
    previousArchiveEndMsBySlugInRepo.set(slugInRepo, archiveDayEndMs);
    const history = readCachedTicketHistory(spec.repoRoot);
    const nodes = spec.nodes ?? [];
    const units = nodes.filter((node) => node.kind === "unit");
    const isLandedInWindow = (committedAtMs: number) => committedAtMs >= windowStartMs && committedAtMs < archiveDayEndMs;
    const landedUnits = new Set(units.filter((unit) => history?.get(slug)?.get(unit.id)?.some(isLandedInWindow)).map((unit) => unit.id));
    rows.push([
      repo, slug, outcome, date, String(units.length), history ? String(landedUnits.size) : "?",
      String(nodes.find((node) => node.kind === "goal")?.criteria?.length ?? 0),
      String(nodes.filter((node) => node.kind === "decision").length),
      String(nodes.filter((node) => node.kind === "openQuestion").length),
    ]);
  }
  rows.sort((first, second) => first[3].localeCompare(second[3]) || first[0].localeCompare(second[0]) || first[1].localeCompare(second[1]));
  const table = [["Repo", "Slug", "Outcome", "Date", "Units planned", "Tickets landed", "Criteria", "Decisions", "Open questions"], ...rows];
  const widths = table[0].map((_, index) => Math.max(...table.map((row) => row[index].length)));
  process.stdout.write(`${table.map((row) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd()).join("\n")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  reportSpecs();
}
