import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "../..");
const PUBLIC_DIR = path.join(ROOT, "public");
const OWNER = path.join(PUBLIC_DIR, "sandboxed-frame.ts");
const NEVER_RENDERED_SOURCES = new Set([path.join(PUBLIC_DIR, "perf.html"), path.join(PUBLIC_DIR, "favicon-core.ts")]);
const SKIP_DIRS = new Set(["node_modules", "dist"]);
const TITLE_WRITES = [
  /(?<!document)\.title\s*(?:\+|\?\?|\|\||&&)?=(?!=)/g,
  /\[\s*['"`]title['"`]\s*\]\s*(?:\+|\?\?|\|\||&&)?=(?!=)/gi,
  /\w*(?:Attribute\w*|Element(?:NS)?|Shape\w*)\([^;]*?(?:['"`]title['"`]|(?<!\$\{)(?<![.\w$'"`-])title\s*[:,}])/gi,
  /<svg\b[^]*?<title\b/gi,
  /<[a-z][^>]*\stitle\s*=/gi,
  /Object\.assign\([^;]*?\btitle\b/g,
];
const OWNER_TITLE_WRITE = "frame.title = title";

function titleWritesIn(source: string): string[] {
  return TITLE_WRITES.flatMap((pattern) => source.match(pattern) ?? []);
}

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

test("only sandboxed-frame.ts sets a title attribute in the dashboard, and only on its frame", () => {
  const files = collectDashboardSources(PUBLIC_DIR, []);
  assert.ok(files.includes(OWNER), "public/sandboxed-frame.ts must exist");
  assert.ok(fs.readFileSync(OWNER, "utf8").includes(OWNER_TITLE_WRITE), "the owner no longer sets its frame title, so the gate would pass vacuously");
  assert.deepEqual(titleWritesIn(fs.readFileSync(OWNER, "utf8")), [".title ="], `public/sandboxed-frame.ts may set a title only through ${OWNER_TITLE_WRITE}`);

  const offenders = files
    .filter((file) => file !== OWNER && !NEVER_RENDERED_SOURCES.has(file) && titleWritesIn(fs.readFileSync(file, "utf8")).length > 0)
    .map((file) => path.relative(ROOT, file));

  assert.deepEqual(offenders, [], `A title attribute is a hover tooltip, which touch screens cannot show. Put the text on the page, or in aria-label when it only names a control:\n  ${offenders.join("\n  ")}`);
});
