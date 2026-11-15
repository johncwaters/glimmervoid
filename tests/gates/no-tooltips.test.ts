import '../helpers/isolate-home.ts';
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "../..");
const PUBLIC_DIR = path.join(ROOT, "public");
const OWNER_TITLE_WRITE_BY_FILE = new Map([
  [path.join(PUBLIC_DIR, "sandboxed-frame.ts"), "frame.title = title"],
  [path.join(PUBLIC_DIR, "ui", "pressable.ts"), "pressable.title = shortcutKey ?"],
]);
const LABEL_ICON_PRESSABLE_HOME = path.join(PUBLIC_DIR, "ui", "pressable.ts");
const LABEL_ICON_PRESSABLE_CALLERS = new Set([path.join(PUBLIC_DIR, "whiteboard", "boards-view.ts")]);
const HOVER_REVEALED_CONTENT = /[^{}]*:(?:hover|focus(?:-visible|-within)?)[^{}]*\{[^}]*\bcontent\s*:[^}]*\}/g;
const FLOATING_OR_ATTRIBUTE_TEXT = /\bcontent\s*:[^;}]*\battr\(|\bposition\s*:\s*(?:absolute|fixed)/;
const NEVER_RENDERED_SOURCES = new Set([path.join(PUBLIC_DIR, "perf.html"), path.join(PUBLIC_DIR, "favicon-core.ts")]);
const SKIP_DIRS = new Set(["node_modules", "dist"]);
const TITLE_WRITES = [
  /(?<!document)\.title\s*(?:\+|\?\?|\|\||&&)?=(?!=)/g,
  /\[\s*['"`]title['"`]\s*\]\s*(?:\+|\?\?|\|\||&&)?=(?!=)/gi,
  /\w*(?:Attribute\w*|Element(?:NS)?|Shape\w*)\([^;]*?(?:['"`]title['"`]|(?<!\$\{)(?<![.\w$'"`-])title\s*[:,}])/gi,
  /<svg\b[\s\S]*?<title\b/gi,
  /<[a-z][^>]*\stitle\s*=/gi,
  /Object\.assign\([^;]*?\btitle\b/g,
];

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
    if (entry.isFile() && /\.(ts|html|css)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

test("a title attribute is set only by labelIconPressable, as an icon-only button's native name, and by sandboxed-frame.ts on its frame", () => {
  const files = collectDashboardSources(PUBLIC_DIR, []).filter((file) => !file.endsWith(".css"));
  for (const [owner, ownerTitleWrite] of OWNER_TITLE_WRITE_BY_FILE) {
    const ownerName = path.relative(ROOT, owner);
    assert.ok(files.includes(owner), `${ownerName} must exist`);
    assert.ok(fs.readFileSync(owner, "utf8").includes(ownerTitleWrite), `${ownerName} no longer sets its title, so the gate would pass vacuously`);
    assert.deepEqual(titleWritesIn(fs.readFileSync(owner, "utf8")), [".title ="], `${ownerName} may set a title only through ${ownerTitleWrite}`);
  }

  const offenders = files
    .filter((file) => !OWNER_TITLE_WRITE_BY_FILE.has(file) && !NEVER_RENDERED_SOURCES.has(file) && titleWritesIn(fs.readFileSync(file, "utf8")).length > 0)
    .map((file) => path.relative(ROOT, file));

  assert.deepEqual(offenders, [], `A title attribute is a hover tooltip, which touch screens cannot show. Name an icon-only button with labelIconPressable (public/ui/pressable.ts); otherwise put the text on the page, or in aria-label when it only names a control:\n  ${offenders.join("\n  ")}`);
});

test("the dashboard builds no custom tooltip: native titles from labelIconPressable are the only hover names", () => {
  const offenders = collectDashboardSources(PUBLIC_DIR, [])
    .filter((file) => !NEVER_RENDERED_SOURCES.has(file) && /tooltip/i.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(ROOT, file));

  assert.deepEqual(offenders, [], `A custom tooltip (a tooltip role, class or component) is a second hover system beside the browser's own. Name an icon-only button with labelIconPressable instead:\n  ${offenders.join("\n  ")}`);
});

test("labelIconPressable is called only from the icon-only toolbars that need a hover name", () => {
  const offenders = collectDashboardSources(PUBLIC_DIR, [])
    .filter((file) => file !== LABEL_ICON_PRESSABLE_HOME && !LABEL_ICON_PRESSABLE_CALLERS.has(file) && fs.readFileSync(file, "utf8").includes("labelIconPressable"))
    .map((file) => path.relative(ROOT, file));

  assert.deepEqual(offenders, [], `labelIconPressable names a button that shows no text; a button with a visible label needs no hover name. Add an icon-only toolbar to LABEL_ICON_PRESSABLE_CALLERS only after checking every button it names shows no text:\n  ${offenders.join("\n  ")}`);
});

test("no stylesheet floats generated text, or reads it from an attribute, on hover or focus: the CSS shape of a custom tooltip", () => {
  const offenders = collectDashboardSources(PUBLIC_DIR, [])
    .filter((file) => file.endsWith(".css"))
    .flatMap((file) => (fs.readFileSync(file, "utf8").match(HOVER_REVEALED_CONTENT) ?? []).filter((rule) => FLOATING_OR_ATTRIBUTE_TEXT.test(rule)).map((rule) => `${path.relative(ROOT, file)}: ${rule.trim().slice(0, 120)}`));

  assert.deepEqual(offenders, [], `A hover or focus rule whose generated text floats or comes from an attribute builds a custom tooltip. Name an icon-only button with labelIconPressable instead:\n  ${offenders.join("\n  ")}`);
});
