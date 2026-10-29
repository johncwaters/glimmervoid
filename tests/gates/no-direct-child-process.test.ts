import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

import * as childProcessSafe from "../../server/child-process-safe.ts";

const ROOT = path.join(import.meta.dirname, "../..");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "public",
  "tests",
  "harness",
  "scripts",
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
  path.join(ROOT, "session", "sessions.ts"),
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
    `These modules import node-pty outside the guarded pty.spawn sites; spawn through session/sessions.ts or call assertLaunchable before pty.spawn:\n  ${offenders.join("\n  ")}`,
  );
});

test("child-process-safe.ts exists and exports the spawn surface", () => {
  const { execFile, execFileSync, execSync, spawn, hide } = childProcessSafe;
  for (const [name, fn] of Object.entries({ execFile, execFileSync, execSync, spawn, hide })) {
    assert.equal(typeof fn, "function", `child-process-safe must export ${name}`);
  }
});

