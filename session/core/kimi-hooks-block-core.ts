import { createHash } from "node:crypto";
import path from "node:path";

import { buildHookCommand } from "./hook-command-core.ts";

type KimiBlockClassification = "absent" | "current" | "managed-stale" | "foreign" | "conflicting";

interface KimiHooksBlockOptions {
  relayPath: string;
  events: readonly string[];
  toolEvents: readonly string[];
  matchedToolNames: readonly string[];
  saneYolo: { relayPath: string; toolNames: readonly string[]; agentFlavor: string };
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
  const saneYoloCommand = buildHookCommand(options.saneYolo.relayPath, "saneYolo", [options.saneYolo.agentFlavor]);
  if (!saneYoloCommand) return null;
  for (const toolName of options.saneYolo.toolNames) lines.push(...hookTable("PreToolUse", saneYoloCommand, `^${toolName}$`));
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

const KIMI_CONFIG_NAME = "config.toml";
const KIMI_SOURCES_NAME = ".glimmervoid-sources.json";
const GENERATED_ONLY_NAMES: ReadonlySet<string> = new Set([KIMI_CONFIG_NAME, KIMI_SOURCES_NAME]);

type KimiLinkKind = "symlink" | "junction" | "hardlink";

interface RealKimiEntry {
  name: string;
  kind: "folder" | "file";
}

interface GeneratedKimiEntry {
  name: string;
  kind: "link" | "folder" | "file";
  linkTarget: string | null;
}

interface KimiHomeInputs {
  realHome: string;
  realEntries: readonly RealKimiEntry[];
  generatedEntries: readonly GeneratedKimiEntry[];
  realConfigText: string | null;
  generatedConfigText: string | null;
  hooksBlock: string;
  sourceStamps: Readonly<Record<string, string>>;
  platform: NodeJS.Platform;
}

type KimiHomeStep =
  | { kind: "link"; name: string; target: string; linkKind: KimiLinkKind }
  | { kind: "unlink"; name: string }
  | { kind: "write-config"; text: string };

type KimiHomePlan =
  | { kind: "ready"; steps: KimiHomeStep[]; sourceStamps: Record<string, string>; privateNames: string[]; hasStaleBlockInRealConfig: boolean }
  | { kind: "refused"; reason: string };

function generatedKimiConfig(realConfigText: string | null, hooksBlock: string): { text: string; hadBlock: boolean } | { refusal: string } {
  const configText = realConfigText ?? "";
  const span = locateBlock(configText);
  if (span === "foreign") return { refusal: "its Glimmervoid hooks block markers are unbalanced" };
  const operatorText = span === "absent" ? configText : `${configText.slice(0, span.start)}${configText.slice(span.end)}`;
  if (definesHooksOutsideArrayTables(operatorText)) return { refusal: "it defines hooks as a key or [hooks] table, which a [[hooks]] block cannot extend" };
  const spliced = spliceKimiHooksBlock(operatorText, hooksBlock);
  if ("refused" in spliced) return { refusal: `its hooks are ${spliced.refused}` };
  return { text: spliced.contents, hadBlock: span !== "absent" };
}

function configSourceStamp(realConfigText: string | null, hooksBlock: string): string {
  return createHash("sha256").update(realConfigText ?? "").update("\0").update(hooksBlock).digest("hex");
}

function linkKindFor(kind: RealKimiEntry["kind"], platform: NodeJS.Platform): KimiLinkKind {
  if (platform !== "win32") return "symlink";
  return kind === "folder" ? "junction" : "hardlink";
}

function planEntryLink(real: RealKimiEntry, generated: GeneratedKimiEntry | undefined, realHome: string, platform: NodeJS.Platform): KimiHomeStep[] | "private" {
  const target = path.join(realHome, real.name);
  const link: KimiHomeStep = { kind: "link", name: real.name, target, linkKind: linkKindFor(real.kind, platform) };
  if (!generated) return [link];
  if (generated.kind !== "link") return "private";
  if (generated.linkTarget === target) return [];
  return [{ kind: "unlink", name: real.name }, link];
}

function planKimiHome(inputs: KimiHomeInputs): KimiHomePlan {
  const config = generatedKimiConfig(inputs.realConfigText, inputs.hooksBlock);
  if ("refusal" in config) return { kind: "refused", reason: `the real ${KIMI_CONFIG_NAME} cannot take the hooks block: ${config.refusal}` };
  const steps: KimiHomeStep[] = [];
  const configStamp = configSourceStamp(inputs.realConfigText, inputs.hooksBlock);
  const isGeneratedConfigCurrent = inputs.generatedConfigText !== null
    && inputs.sourceStamps[KIMI_CONFIG_NAME] === configStamp
    && classifyKimiConfig(inputs.generatedConfigText, inputs.hooksBlock) === "current";
  if (!isGeneratedConfigCurrent) steps.push({ kind: "write-config", text: config.text });
  const generatedByName = new Map(inputs.generatedEntries.map((entry) => [entry.name, entry]));
  const realNames = new Set<string>();
  const privateNames: string[] = [];
  for (const real of inputs.realEntries) {
    if (GENERATED_ONLY_NAMES.has(real.name)) continue;
    realNames.add(real.name);
    const entrySteps = planEntryLink(real, generatedByName.get(real.name), inputs.realHome, inputs.platform);
    if (entrySteps === "private") {
      privateNames.push(real.name);
      continue;
    }
    steps.push(...entrySteps);
  }
  for (const generated of inputs.generatedEntries) {
    if (generated.kind === "link" && !realNames.has(generated.name)) steps.push({ kind: "unlink", name: generated.name });
  }
  return {
    kind: "ready",
    steps,
    sourceStamps: { ...inputs.sourceStamps, [KIMI_CONFIG_NAME]: configStamp },
    privateNames,
    hasStaleBlockInRealConfig: config.hadBlock,
  };
}

export { BLOCK_START, BLOCK_END, KIMI_CONFIG_NAME, KIMI_SOURCES_NAME, renderKimiHooksBlock, classifyKimiConfig, spliceKimiHooksBlock, generatedKimiConfig, planKimiHome };
export type { GeneratedKimiEntry, KimiBlockClassification, KimiHomeInputs, KimiHomePlan, KimiHomeStep, KimiHooksBlockOptions, KimiLinkKind, RealKimiEntry };
