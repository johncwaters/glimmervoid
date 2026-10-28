import { buildHookCommand } from "./hook-command-core.ts";

type KimiBlockClassification = "absent" | "current" | "managed-stale" | "foreign" | "conflicting";

interface KimiHooksBlockOptions {
  relayPath: string;
  events: readonly string[];
  toolEvents: readonly string[];
  matchedToolNames: readonly string[];
}

type KimiSpliceResult = { contents: string; changed: boolean } | { refused: "foreign" | "conflicting" };

const BLOCK_START = "# >>> glimmervoid hooks (managed, inert outside Glimmervoid) >>>";
const BLOCK_END = "# <<< glimmervoid hooks <<<";

const MANAGED_LINE_PATTERNS: readonly RegExp[] = Object.freeze([
  /^\[\[hooks\]\]$/,
  /^event = "[A-Za-z][A-Za-z0-9_-]{0,63}"$/,
  /^matcher = '\^[A-Za-z0-9_]+\$'$/,
  /^command = 'node (?:"[^"'\r\n]*\/(?:hook-relay|hook-tool-relay)\.(?:js|ts)"|[^\s"']*\/(?:hook-relay|hook-tool-relay)\.(?:js|ts)) [A-Za-z][A-Za-z0-9_-]{0,63}(?: [A-Za-z0-9_-]+)*'$/,
]);

function hookTable(event: string, command: string, matcher: string | null = null): string[] {
  const lines = ["[[hooks]]", `event = "${event}"`];
  if (matcher !== null) lines.push(`matcher = '${matcher}'`);
  lines.push(`command = '${command}'`);
  return lines;
}

function renderKimiHooksBlock(options: KimiHooksBlockOptions): string | null {
  const lines = [BLOCK_START];
  for (const event of options.events) {
    const command = buildHookCommand(options.relayPath, event);
    if (!command) return null;
    lines.push(...hookTable(event, command));
  }
  for (const event of options.toolEvents) {
    const command = buildHookCommand(options.relayPath, event);
    if (!command) return null;
    for (const toolName of options.matchedToolNames) lines.push(...hookTable(event, command, `^${toolName}$`));
  }
  lines.push(BLOCK_END);
  return `${lines.join("\n")}\n`;
}

interface BlockSpan {
  start: number;
  end: number;
}

function lineEndAfter(configText: string, index: number): number {
  const newlineIndex = configText.indexOf("\n", index);
  return newlineIndex === -1 ? configText.length : newlineIndex + 1;
}

function locateBlock(configText: string): BlockSpan | "absent" | "foreign" {
  const lines = configText.split("\n");
  let offset = 0;
  let start: number | null = null;
  let end: number | null = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (line === BLOCK_START) {
      if (start !== null) return "foreign";
      start = offset;
    }
    if (line === BLOCK_END) {
      if (start === null || end !== null) return "foreign";
      end = lineEndAfter(configText, offset);
    }
    offset += rawLine.length + 1;
  }
  if (start === null && end === null) return "absent";
  if (start === null || end === null) return "foreign";
  return { start, end };
}

function isManagedBlockBody(blockText: string): boolean {
  const bodyLines = blockText.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line !== "");
  const innerLines = bodyLines.slice(1, -1);
  return innerLines.every((line) => MANAGED_LINE_PATTERNS.some((pattern) => pattern.test(line)));
}

const TABLE_HEADER_PATTERN = /^\s*\[/;
const HOOKS_TABLE_HEADER_PATTERN = /^\s*\[\s*hooks\s*[\].]/;
const TOP_LEVEL_HOOKS_KEY_PATTERN = /^\s*hooks\s*[=.]/;

function definesHooksOutsideArrayTables(operatorText: string): boolean {
  let isAtTopLevel = true;
  for (const line of operatorText.split("\n")) {
    if (HOOKS_TABLE_HEADER_PATTERN.test(line)) return true;
    if (TABLE_HEADER_PATTERN.test(line)) isAtTopLevel = false;
    if (isAtTopLevel && TOP_LEVEL_HOOKS_KEY_PATTERN.test(line)) return true;
  }
  return false;
}

function classifyKimiConfig(configText: string | null, expectedBlock: string): KimiBlockClassification {
  if (configText === null) return "absent";
  const span = locateBlock(configText);
  if (span === "foreign") return span;
  const operatorText = span === "absent" ? configText : `${configText.slice(0, span.start)}${configText.slice(span.end)}`;
  if (definesHooksOutsideArrayTables(operatorText)) return "conflicting";
  if (span === "absent") return span;
  const blockText = configText.slice(span.start, span.end);
  if (blockText === expectedBlock) return "current";
  if (isManagedBlockBody(blockText)) return "managed-stale";
  return "foreign";
}

function spliceKimiHooksBlock(configText: string | null, block: string): KimiSpliceResult {
  if (configText === null || configText === "") return { contents: block, changed: true };
  const classification = classifyKimiConfig(configText, block);
  if (classification === "current") return { contents: configText, changed: false };
  if (classification === "foreign" || classification === "conflicting") return { refused: classification };
  if (classification === "absent") {
    const separator = configText.endsWith("\n") ? "\n" : "\n\n";
    return { contents: `${configText}${separator}${block}`, changed: true };
  }
  const span = locateBlock(configText);
  if (span === "absent" || span === "foreign") return { refused: "foreign" };
  return { contents: `${configText.slice(0, span.start)}${block}${configText.slice(span.end)}`, changed: true };
}

export { BLOCK_START, BLOCK_END, renderKimiHooksBlock, classifyKimiConfig, spliceKimiHooksBlock };
export type { KimiBlockClassification, KimiHooksBlockOptions };
