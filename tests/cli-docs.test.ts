import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(import.meta.dirname, '..');
const DOCS_NAMING_CLI_COMMANDS = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/troubleshooting.md', 'docs/testing-cli.md', 'docs/distribution.md'];
const CLI_INVOCATION = /(?:bin\/glimmervoid\.ts|(?<![-\w/.])(?<!-g )glimmervoid) ((?:--?)?[a-z][a-z-]*)/g;

function helpText(): string {
  return execFileSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'glimmervoid.ts'), '--help'], { encoding: 'utf8' }).trimEnd();
}

function codeIn(markdown: string): string[] {
  const fencedBlocks = [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]);
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, '');
  const inlineSpans = [...withoutFences.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
  return [...fencedBlocks, ...inlineSpans];
}

function documentedInvocations(): { file: string; word: string }[] {
  const invocations: { file: string; word: string }[] = [];
  for (const file of DOCS_NAMING_CLI_COMMANDS) {
    const markdown = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const code of codeIn(markdown)) {
      for (const match of code.matchAll(CLI_INVOCATION)) invocations.push({ file, word: match[1] });
    }
  }
  return invocations;
}

function isKnownToHelp(word: string, help: string): boolean {
  if (word.startsWith('-')) return help.includes(word);
  return help.split('\n').some((line) => line.startsWith(`  ${word} `) || line.trim() === word);
}

test('docs/testing-cli.md carries the current --help output verbatim', () => {
  const guide = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'testing-cli.md'), 'utf8');
  assert.ok(guide.includes(`\`\`\`\n${helpText()}\n\`\`\``), 'paste the output of node bin/glimmervoid.ts --help into Test 1');
});

test('every glimmervoid command or flag the docs show exists in --help', () => {
  const help = helpText();
  const invocations = documentedInvocations();
  assert.ok(invocations.length > 0);
  const unknown = invocations.filter(({ word }) => !isKnownToHelp(word, help)).map(({ file, word }) => `${file}: ${word}`);
  assert.deepEqual(unknown, []);
});
