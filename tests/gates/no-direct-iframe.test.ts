import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "../..");
const PUBLIC_DIR = path.join(ROOT, "public");
const OWNER = path.join(PUBLIC_DIR, "sandboxed-frame.ts");
const SKIP_DIRS = new Set(["node_modules", "dist"]);
const IFRAME_CREATION = /['"`]iframe['"`]|<iframe\b/i;

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

test("only sandboxed-frame.ts creates iframes in the dashboard", () => {
  const files = collectDashboardSources(PUBLIC_DIR, []);
  assert.ok(files.includes(OWNER), "public/sandboxed-frame.ts must exist");
  assert.match(fs.readFileSync(OWNER, "utf8"), IFRAME_CREATION, "the owner no longer matches the iframe pattern, so the gate would pass vacuously");

  const offenders = files
    .filter((file) => file !== OWNER && IFRAME_CREATION.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(ROOT, file));

  assert.deepEqual(offenders, [], `Create frames through createSandboxedFrame in public/sandboxed-frame.ts instead:\n  ${offenders.join("\n  ")}`);
});
