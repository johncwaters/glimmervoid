import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "../..");
const PUBLIC_DIR = path.join(ROOT, "public");
const OWNER = path.join(PUBLIC_DIR, "hover-tip.ts");
const SKIP_DIRS = new Set(["node_modules", "dist"]);
const RAW_TIP_WRITE = /tip(Label|Detail)|data-tip-/;

function collectDashboardSources(dir: string, acc: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectDashboardSources(full, acc);
      continue;
    }
    if (entry.isFile() && /\.(ts|html)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

test("only hover-tip.ts writes hover tip text, so the typed length limits cannot be bypassed", () => {
  const files = collectDashboardSources(PUBLIC_DIR, []);
  assert.ok(files.includes(OWNER), "public/hover-tip.ts must exist");
  assert.match(fs.readFileSync(OWNER, "utf8"), RAW_TIP_WRITE, "the owner no longer matches the tip write pattern, so the gate would pass vacuously");

  const offenders = files
    .filter((file) => file !== OWNER && RAW_TIP_WRITE.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(ROOT, file));

  assert.deepEqual(offenders, [], `Set hover tips through setHoverTip in public/hover-tip.ts instead:\n  ${offenders.join("\n  ")}`);
});
