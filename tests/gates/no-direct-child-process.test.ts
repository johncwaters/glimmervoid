import '../helpers/isolate-home.ts';
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import * as childProcessSafe from "../../server/child-process-safe.ts";

const ROOT = path.join(import.meta.dirname, "../..");
const SHELL_TRUE_PATTERN = /(?:\b['"]?shell['"]?\s*:\s*true\b|\.\s*shell\s*=\s*true\b)/g;

const SHELL_TRUE_EXCEPTIONS: Readonly<Record<string, { count: number; reason: string }>> = {
  "session/statusline-relay.ts": {
    count: 1,
    reason: "chains to the operator-configured Claude Code statusLine shell command string",
  },
};

function stripCommentsPreservingLines(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function shellTrueViolationsIn(repoPath: string, source: string): string[] {
  const stripped = stripCommentsPreservingLines(source);
  const violations: string[] = [];
  for (const match of stripped.matchAll(SHELL_TRUE_PATTERN)) {
    const line = lineNumberAt(stripped, match.index ?? 0);
    violations.push(`${repoPath}:${line}: forbidden shell: true (spawn directly via server/child-process-safe.ts or session/drivers/pty-driver.ts with argv array)`);
  }
  return violations;
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "public",
  "tests",
  "harness",
  "scripts",
  "examples",
  ".git",
  ".omc",
  ".glimmervoid",
  ".claude",
  ".glimmervoid-worktrees",
]);

const ALLOWED = new Set([
  path.join(ROOT, "server", "child-process-safe.js"),
  path.join(ROOT, "server", "child-process-safe.ts"),
]);

const CHILD_PROCESS_REQUIRE =
  /require\(\s*['"](?:node:)?child_process['"]\s*\)|\bfrom\s*['"](?:node:)?child_process['"]|\bimport\s*\(\s*['"](?:node:)?child_process['"]\s*\)/;

const TYPE_ONLY_LINE = /^\s*\*|^\s*\/\*\*|\bimport\s+type\b|@(?:type|typedef|param|property|returns)\b/;

function hasRuntimeImport(src: string, importPattern: RegExp): boolean {
  return src.split("\n").some((line) => !TYPE_ONLY_LINE.test(line) && importPattern.test(line));
}

function collectJsFiles(dir: string, acc: string[]): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(full, acc);
      continue;
    }
    if (entry.isFile() && /\.(js|mjs|cjs|ts|mts|cts)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

test("only child-process-safe.ts imports child_process directly (all spawns go through it)", () => {
  const files = collectJsFiles(ROOT, []);

  assert.ok(files.length > 20, `expected to scan the runtime tree, only found ${files.length} files`);

  const offenders: string[] = [];
  for (const file of files) {
    if (ALLOWED.has(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    if (hasRuntimeImport(src, CHILD_PROCESS_REQUIRE)) offenders.push(path.relative(ROOT, file));
  }

  assert.deepEqual(
    offenders,
    [],
    `These modules must import './child-process-safe.ts' instead of child_process directly:\n  ${offenders.join("\n  ")}`,
  );
});

const PTY_IMPORTERS = new Set([
  path.join(ROOT, "session", "drivers", "pty-driver.ts"),
  path.join(ROOT, "server", "agent-login", "agent-connect.ts"),
  path.join(ROOT, "server", "node-pty-preflight.ts"),
]);

const NODE_PTY_IMPORT = /\bfrom\s*['"]node-pty['"]|\bimport\s*\(\s*['"]node-pty['"]\s*\)|require\(\s*['"]node-pty['"]\s*\)/;

test("only the pty.spawn sites that call assertLaunchable import node-pty", () => {
  const offenders = collectJsFiles(ROOT, [])
    .filter((file) => !PTY_IMPORTERS.has(file))
    .filter((file) => hasRuntimeImport(fs.readFileSync(file, "utf8"), NODE_PTY_IMPORT))
    .map((file) => path.relative(ROOT, file));

  assert.deepEqual(
    offenders,
    [],
    `These modules import node-pty outside the guarded pty.spawn sites; spawn through session/drivers/pty-driver.ts or call assertLaunchable before pty.spawn:\n  ${offenders.join("\n  ")}`,
  );
});

test("child-process-safe.ts exists and exports the spawn surface", () => {
  const { execFile, execFileSync, execSync, spawn, hide } = childProcessSafe;
  for (const [name, fn] of Object.entries({ execFile, execFileSync, execSync, spawn, hide })) {
    assert.equal(typeof fn, "function", `child-process-safe must export ${name}`);
  }
});

test("no runtime source uses shell: true outside the recorded exception list", () => {
  const files = collectJsFiles(ROOT, []);
  assert.ok(files.length > 20, `expected to scan the runtime tree, only found ${files.length} files`);

  const violations: string[] = [];
  for (const file of files) {
    const repoPath = path.relative(ROOT, file).split(path.sep).join("/");
    if (repoPath in SHELL_TRUE_EXCEPTIONS) continue;
    violations.push(...shellTrueViolationsIn(repoPath, fs.readFileSync(file, "utf8")));
  }

  for (const [exceptionPath, exception] of Object.entries(SHELL_TRUE_EXCEPTIONS)) {
    const matches = shellTrueViolationsIn(exceptionPath, fs.readFileSync(path.join(ROOT, exceptionPath), "utf8"));
    assert.equal(
      matches.length,
      exception.count,
      `recorded shell: true exception ${exceptionPath} (${exception.reason}) expected ${exception.count} occurrence(s), found ${matches.length}`,
    );
  }

  assert.deepEqual(
    violations,
    [],
    `Found shell: true outside SHELL_TRUE_EXCEPTIONS:\n  ${violations.join("\n  ")}`,
  );
});

test("shell: true gate flags planted violations with file, line, and allowed route", () => {
  const planted = [
    "import { spawn } from '../server/child-process-safe.ts';",
    "spawn('ls', ['-la'], { shell: true });",
    "/* comment */ spawn('ls', { shell:\n  true });",
    "const opts: { shell?: boolean } = {}; opts.shell = true;",
  ].join("\n");
  const violations = shellTrueViolationsIn("session/planted-example.ts", planted);
  assert.equal(violations.length, 3);
  assert.match(violations[0], /session\/planted-example\.ts:2:/);
  assert.match(violations[1], /session\/planted-example\.ts:3:/);
  assert.match(violations[2], /session\/planted-example\.ts:5:/);
  assert.match(violations[0], /server\/child-process-safe\.ts/);
});

