import '../helpers/isolate-home.ts';
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import treeSitter from "@vscode/tree-sitter-wasm";
import type { Parser } from "@vscode/tree-sitter-wasm";
import { grammarWasmPath, treeSitterRuntimeWasmPath } from "../../server/runtime-paths.ts";

const ROOT = path.join(import.meta.dirname, "../..");
const PUBLIC_DIR = path.join(ROOT, "public");
const OWNER_TITLE_WRITE_BY_FILE = new Map([
  [path.join(PUBLIC_DIR, "sandboxed-frame.ts"), "frame.title = title"],
  [path.join(PUBLIC_DIR, "ui", "pressable.ts"), "pressable.title = shortcutKey ?"],
]);
const LABEL_ICON_PRESSABLE_HOME = path.join(PUBLIC_DIR, "ui", "pressable.ts");
const LABEL_ICON_PRESSABLE_CALLERS = new Set([path.join(PUBLIC_DIR, "whiteboard", "boards-view.ts"), path.join(PUBLIC_DIR, "board-session", "Dock.tsx")]);
const HOVER_REVEALED_CONTENT = /[^{}]*:(?:hover|focus(?:-visible|-within)?)[^{}]*\{[^}]*\bcontent\s*:[^}]*\}/g;
const FLOATING_OR_ATTRIBUTE_TEXT = /\bcontent\s*:[^;}]*\battr\(|\bposition\s*:\s*(?:absolute|fixed)/;
const NEVER_RENDERED_SOURCES = new Set([path.join(PUBLIC_DIR, "perf.html"), path.join(PUBLIC_DIR, "favicon-core.ts")]);
const SKIP_DIRS = new Set(["node_modules", "dist"]);
const HTML_TAG_TITLE_WRITE = /<[a-z](?:=>|[^>])*\stitle\s*=/gi;
const INTRINSIC_OR_PASSTHROUGH_JSX_TAG = /^(?:[a-z][a-z0-9-]*|Pressable|Dynamic)$/;
const JSX_TITLE_ATTRIBUTE_NAME = /^title$/i;
const TITLE_WRITES = [
  /(?<!document)\.title\s*(?:\+|\?\?|\|\||&&)?=(?!=)/g,
  /\[\s*['"`]title['"`]\s*\]\s*(?:\+|\?\?|\|\||&&)?=(?!=)/gi,
  /\w*(?:Attribute\w*|Element(?:NS)?|Shape\w*)\([^;]*?(?:['"`]title['"`]|(?<!\$\{)(?<![.\w$'"`-])title\s*[:,}])/gi,
  /<svg\b[\s\S]*?<title\b/gi,
  /Object\.assign\([^;]*?\btitle\b/g,
];

let cachedTsxParserPromise: Promise<Parser> | null = null;

function tsxParser(): Promise<Parser> {
  cachedTsxParserPromise ??= (async () => {
    const runtimeWasmPath = treeSitterRuntimeWasmPath();
    assert.ok(runtimeWasmPath, "tree-sitter runtime (@vscode/tree-sitter-wasm) must be installed");
    await treeSitter.Parser.init({ locateFile: () => runtimeWasmPath });
    const tsxWasmPath = grammarWasmPath("tsx");
    assert.ok(tsxWasmPath, "tree-sitter tsx grammar (tree-sitter-wasms) must be installed");
    const language = await treeSitter.Language.load(new Uint8Array(await fs.promises.readFile(tsxWasmPath)));
    const parser = new treeSitter.Parser();
    parser.setLanguage(language);
    return parser;
  })();
  return cachedTsxParserPromise;
}

async function tsxTitleWritesIn(source: string): Promise<string[]> {
  const parser = await tsxParser();
  const tree = parser.parse(source);
  assert.ok(tree, "tree-sitter failed to parse TSX source");
  const matches: string[] = [];
  for (const element of tree.rootNode.descendantsOfType(["jsx_opening_element", "jsx_self_closing_element"])) {
    if (!element) continue;
    const tagName = element.childForFieldName("name")?.text ?? "";
    if (!INTRINSIC_OR_PASSTHROUGH_JSX_TAG.test(tagName)) continue;
    const hasTitleAttribute = element.namedChildren.some(
      (child) => child?.type === "jsx_attribute" && JSX_TITLE_ATTRIBUTE_NAME.test(child.namedChildren[0]?.text ?? ""),
    );
    if (hasTitleAttribute) matches.push(element.text.slice(0, 80));
  }
  for (const literal of tree.rootNode.descendantsOfType(["string", "template_string"])) {
    if (!literal) continue;
    const htmlMatches = literal.text.match(HTML_TAG_TITLE_WRITE);
    if (htmlMatches) matches.push(...htmlMatches);
  }
  tree.delete();
  return matches;
}

async function titleWritesIn(source: string, isTsx = false): Promise<string[]> {
  const regexMatches = TITLE_WRITES.flatMap((pattern) => source.match(pattern) ?? []);
  if (!isTsx) return [...regexMatches, ...(source.match(HTML_TAG_TITLE_WRITE) ?? [])];
  return [...regexMatches, ...(await tsxTitleWritesIn(source))];
}

function collectDashboardSources(dir: string, acc: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectDashboardSources(full, acc);
      continue;
    }
    if (entry.isFile() && /\.(tsx?|html|css)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

test("a title prop on a JSX component passes while a title attribute on an intrinsic element in .tsx fails", async () => {
  assert.deepEqual(
    await titleWritesIn('<Dialog title="Pick agent" open={true}><SectionHeading title="Agents" level={3} /></Dialog>', true),
    [],
  );
  assert.ok((await titleWritesIn('<div title="hover tip">hello</div>', true)).length > 0);
  assert.ok((await titleWritesIn('<dialog title={props.title}></dialog>', true)).length > 0);
  assert.ok((await titleWritesIn('<button title={props.title}>Go</button>', true)).length > 0);
  assert.ok((await titleWritesIn('<Pressable title="hover tip" text="Save" />', true)).length > 0);
  assert.ok((await titleWritesIn('<Dynamic component="div" title="hover tip">hello</Dynamic>', true)).length > 0);
  assert.ok((await titleWritesIn('if (count<limit) return <div title="hover tip">hello</div>;', true)).length > 0);
  assert.ok((await titleWritesIn('const hint = "x<y";\nreturn <div title="hover tip">hello</div>;', true)).length > 0);
  assert.ok((await titleWritesIn("el.innerHTML = '<DIV title=\"hover tip\">hi</DIV>';", true)).length > 0);
});

test("a title attribute is set only by labelIconPressable, as an icon-only button's native name, and by sandboxed-frame.ts on its frame", async () => {
  const files = collectDashboardSources(PUBLIC_DIR, []).filter((file) => !file.endsWith(".css"));
  for (const [owner, ownerTitleWrite] of OWNER_TITLE_WRITE_BY_FILE) {
    const ownerName = path.relative(ROOT, owner);
    assert.ok(files.includes(owner), `${ownerName} must exist`);
    assert.ok(fs.readFileSync(owner, "utf8").includes(ownerTitleWrite), `${ownerName} no longer sets its title, so the gate would pass vacuously`);
    assert.deepEqual(await titleWritesIn(fs.readFileSync(owner, "utf8")), [".title ="], `${ownerName} may set a title only through ${ownerTitleWrite}`);
  }

  const offenders: string[] = [];
  for (const file of files) {
    if (OWNER_TITLE_WRITE_BY_FILE.has(file) || NEVER_RENDERED_SOURCES.has(file)) continue;
    const writes = await titleWritesIn(fs.readFileSync(file, "utf8"), file.endsWith(".tsx"));
    if (writes.length > 0) offenders.push(path.relative(ROOT, file));
  }

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
