import path from "node:path";

import { buildHookCommand } from "./hook-command-core.ts";

type BlockClassification = "absent" | "current" | "managed-stale" | "foreign" | "conflicting";

interface KimiHooksBlockOptions {
  relayPath: string;
  events: readonly string[];
  toolEvents: readonly string[];
  matchedToolNames: readonly string[];
  saneYolo: { relayPath: string; toolNames: readonly string[]; agentFlavor: string };
}

type BlockSpliceResult = { contents: string; changed: boolean } | { refused: "foreign" | "conflicting" };

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

function classifyConfig(configText: string | null, expectedBlock: string, profile: AgentHomeProfile): BlockClassification {
  if (configText === null) return "absent";
  const span = locateBlock(configText);
  if (span === "foreign") return span;
  const operatorText = span === "absent" ? configText : `${configText.slice(0, span.start)}${configText.slice(span.end)}`;
  if (profile.hooksConflict(operatorText) !== null) return "conflicting";
  if (span === "absent") return span;
  const blockText = configText.slice(span.start, span.end);
  if (blockText === expectedBlock) return "current";
  if (isManagedBlockBody(blockText)) return "managed-stale";
  return "foreign";
}

function spliceHooksBlock(configText: string | null, block: string, profile: AgentHomeProfile): BlockSpliceResult {
  if (configText === null || configText === "") return { contents: block, changed: true };
  const classification = classifyConfig(configText, block, profile);
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

const AGENT_HOME_CONFIG_NAME = "config.toml";
const AGENT_HOME_SOURCES_NAME = ".glimmervoid-sources.json";
const AGENT_HOME_CONFLICTS_NAME = ".glimmervoid-conflicts";
const AGENT_HOME_BASE_NAME = ".glimmervoid-base.toml";
const AGENT_HOME_IN_USE_LOCK_NAME = ".glimmervoid-in-use.lock";
const GENERATED_ONLY_NAMES: ReadonlySet<string> = new Set([AGENT_HOME_CONFIG_NAME, AGENT_HOME_SOURCES_NAME, AGENT_HOME_CONFLICTS_NAME, AGENT_HOME_BASE_NAME, AGENT_HOME_IN_USE_LOCK_NAME]);
const FILE_STAMP_PREFIX = "file:";

type AgentHomeVendor = "kimi" | "codex";

interface AgentHomeProfile {
  vendor: AgentHomeVendor;
  homeEnvName: string;
  defaultHomeFolderName: string;
  hooksConflict(operatorText: string): string | null;
  sessionOnlyTablePrefixes: readonly string[];
  isPrivateEntryName(name: string, platform: NodeJS.Platform): boolean;
}

type AgentHomeLinkKind = "symlink" | "junction" | "hardlink";

interface RealAgentHomeEntry {
  name: string;
  kind: "folder" | "file";
  fileStamp: string | null;
  childNames: readonly string[];
}

interface GeneratedAgentHomeEntry {
  name: string;
  kind: "link" | "folder" | "file";
  linkTarget: string | null;
  childNames: readonly string[];
}

interface AgentHomeInputs {
  profile: AgentHomeProfile;
  realHome: string;
  realEntries: readonly RealAgentHomeEntry[];
  generatedEntries: readonly GeneratedAgentHomeEntry[];
  realConfigText: string | null;
  baseConfigText: string | null;
  generatedConfigText: string | null;
  renderBlock: (operatorText: string) => string;
  sourceStamps: Readonly<Record<string, string>>;
  platform: NodeJS.Platform;
}

type AgentHomeStep =
  | { kind: "link"; name: string; target: string; linkKind: AgentHomeLinkKind }
  | { kind: "unlink"; name: string }
  | { kind: "promote"; name: string; target: string }
  | { kind: "set-aside"; name: string }
  | { kind: "adopt"; name: string; target: string; childNames: readonly string[] }
  | { kind: "write-config"; text: string }
  | { kind: "write-base"; text: string };

type AgentHomePlan =
  | { kind: "ready"; steps: AgentHomeStep[]; privateNames: string[]; hasStaleBlockInRealConfig: boolean }
  | { kind: "refused"; reason: string };

const TOML_TABLE_HEADER_PATTERN = /^\s*\[\[?([^[\]=]+)\]\]?\s*(?:#.*)?$/;
const TOML_KEY_PATTERN = /^\s*((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=/;
const TOML_MULTILINE_QUOTES: readonly string[] = ['"""', "'''"];

interface TomlUnit {
  id: string;
  text: string;
}

interface TomlUnits {
  preamble: string;
  keys: TomlUnit[];
  tables: TomlUnit[];
}

function withoutBlock(configText: string): string | "foreign" {
  const span = locateBlock(configText);
  if (span === "foreign") return span;
  if (span === "absent") return configText;
  const operatorText = `${configText.slice(0, span.start)}${configText.slice(span.end)}`;
  return operatorText.endsWith("\n\n") ? operatorText.slice(0, -1) : operatorText;
}

function togglesMultilineString(line: string): boolean {
  return TOML_MULTILINE_QUOTES.some((quotes) => line.split(quotes).length % 2 === 0);
}

function splitTomlUnits(configText: string): TomlUnits {
  const units: TomlUnits = { preamble: "", keys: [], tables: [] };
  const tableCounts = new Map<string, number>();
  let current: TomlUnit | null = null;
  let isInTable = false;
  let isInMultilineString = false;
  for (const line of configText.split(/(?<=\n)/)) {
    const header = isInMultilineString ? null : TOML_TABLE_HEADER_PATTERN.exec(line);
    const key = isInMultilineString || isInTable || header ? null : TOML_KEY_PATTERN.exec(line);
    if (togglesMultilineString(line)) isInMultilineString = !isInMultilineString;
    if (header) {
      const headerId = `${line.trim().startsWith("[[") ? "[[" : "["}${(header[1] ?? "").replaceAll(/\s/g, "")}`;
      const occurrence = (tableCounts.get(headerId) ?? 0) + 1;
      tableCounts.set(headerId, occurrence);
      current = { id: `${headerId}#${occurrence}`, text: line };
      units.tables.push(current);
      isInTable = true;
      continue;
    }
    if (key) {
      current = { id: (key[1] ?? "").replaceAll(/\s/g, ""), text: line };
      units.keys.push(current);
      continue;
    }
    if (current) current.text += line;
    if (!current) units.preamble += line;
  }
  return units;
}

function isSameUnit(first: TomlUnit | undefined, second: TomlUnit | undefined): boolean {
  return first?.text.trimEnd() === second?.text.trimEnd();
}

function mergeUnitList(base: readonly TomlUnit[], ours: readonly TomlUnit[], theirs: readonly TomlUnit[]): TomlUnit[] {
  const baseById = new Map(base.map((unit) => [unit.id, unit]));
  const oursById = new Map(ours.map((unit) => [unit.id, unit]));
  const theirIds = new Set(theirs.map((unit) => unit.id));
  const merged: TomlUnit[] = [];
  for (const theirUnit of theirs) {
    const ourUnit = oursById.get(theirUnit.id);
    const isOnlySessionChange = !isSameUnit(ourUnit, baseById.get(theirUnit.id)) && isSameUnit(theirUnit, baseById.get(theirUnit.id));
    if (!isOnlySessionChange) merged.push(theirUnit);
    if (isOnlySessionChange && ourUnit) merged.push(ourUnit);
  }
  for (const ourUnit of ours) {
    if (!theirIds.has(ourUnit.id) && !baseById.has(ourUnit.id)) merged.push(ourUnit);
  }
  return merged;
}

function mergeTopLevelKeys(base: string, ours: string, theirs: string): string {
  if (theirs === base) return ours;
  if (ours === base) return theirs;
  const [baseUnits, ourUnits, theirUnits] = [splitTomlUnits(base), splitTomlUnits(ours), splitTomlUnits(theirs)];
  const keys = mergeUnitList(baseUnits.keys, ourUnits.keys, theirUnits.keys).map((unit) => `${unit.text.trimEnd()}\n`);
  const tables = mergeUnitList(baseUnits.tables, ourUnits.tables, theirUnits.tables).map((unit) => `\n${unit.text.trimEnd()}\n`);
  return [theirUnits.preamble, ...keys, ...tables].join("");
}

function withoutSessionOnlyTables(ours: string, base: string, sessionOnlyTablePrefixes: readonly string[]): string {
  const baseTableTexts = new Set(splitTomlUnits(base).tables.map((unit) => unit.text.trimEnd()));
  const ourUnits = splitTomlUnits(ours);
  const isSessionOnly = (unit: TomlUnit) => sessionOnlyTablePrefixes.some((prefix) => unit.id.startsWith(prefix)) && !baseTableTexts.has(unit.text.trimEnd());
  const keptTables = ourUnits.tables.filter((unit) => !isSessionOnly(unit));
  if (keptTables.length === ourUnits.tables.length) return ours;
  return [ourUnits.preamble, ...ourUnits.keys.map((unit) => unit.text), ...keptTables.map((unit) => unit.text)].join("");
}

interface AgentConfigSources {
  profile: AgentHomeProfile;
  realConfigText: string | null;
  baseConfigText: string | null;
  generatedConfigText: string | null;
  renderBlock: (operatorText: string) => string;
}

function isGeneratedConfigCurrent(generatedConfigText: string, sources: AgentConfigSources): boolean {
  const generatedOperatorText = withoutBlock(generatedConfigText);
  if (generatedOperatorText === "foreign") return false;
  return classifyConfig(generatedConfigText, sources.renderBlock(generatedOperatorText), sources.profile) === "current";
}

function generatedAgentConfig(sources: AgentConfigSources): { text: string; base: string; hadBlock: boolean } | { refusal: string } {
  const realText = sources.realConfigText ?? "";
  const theirs = withoutBlock(realText);
  if (theirs === "foreign") return { refusal: "its Glimmervoid hooks block markers are unbalanced" };
  const hadBlock = theirs !== realText;
  const isRealUnchanged = sources.baseConfigText === theirs;
  if (isRealUnchanged && sources.generatedConfigText !== null && isGeneratedConfigCurrent(sources.generatedConfigText, sources)) {
    return { text: sources.generatedConfigText, base: theirs, hadBlock };
  }
  const ours = sources.generatedConfigText === null ? "foreign" : withoutBlock(sources.generatedConfigText);
  const operatorText = ours === "foreign" || sources.baseConfigText === null
    ? theirs
    : mergeTopLevelKeys(sources.baseConfigText, withoutSessionOnlyTables(ours, sources.baseConfigText, sources.profile.sessionOnlyTablePrefixes), theirs);
  const conflict = sources.profile.hooksConflict(operatorText);
  if (conflict !== null) return { refusal: conflict };
  const spliced = spliceHooksBlock(operatorText, sources.renderBlock(operatorText), sources.profile);
  if ("refused" in spliced) return { refusal: `its hooks are ${spliced.refused}` };
  return { text: spliced.contents, base: theirs, hadBlock };
}

function linkKindFor(kind: RealAgentHomeEntry["kind"], platform: NodeJS.Platform): AgentHomeLinkKind {
  if (platform !== "win32") return "symlink";
  return kind === "folder" ? "junction" : "hardlink";
}

function fileStampKey(name: string): string {
  return `${FILE_STAMP_PREFIX}${name}`;
}

function planReplacedFile(real: RealAgentHomeEntry, target: string, lastFileStamp: string | undefined): AgentHomeStep {
  const isRealUnchanged = real.fileStamp !== null && real.fileStamp === lastFileStamp;
  if (isRealUnchanged) return { kind: "promote", name: real.name, target };
  return { kind: "set-aside", name: real.name };
}

function planPrivateFolder(real: RealAgentHomeEntry, generated: GeneratedAgentHomeEntry, target: string): AgentHomeStep | "private" {
  const realChildNames = new Set(real.childNames);
  if (generated.childNames.some((childName) => realChildNames.has(childName))) return "private";
  return { kind: "adopt", name: real.name, target, childNames: generated.childNames };
}

function planEntryLink(real: RealAgentHomeEntry, generated: GeneratedAgentHomeEntry | undefined, inputs: AgentHomeInputs): AgentHomeStep[] | "private" {
  const target = path.join(inputs.realHome, real.name);
  const link: AgentHomeStep = { kind: "link", name: real.name, target, linkKind: linkKindFor(real.kind, inputs.platform) };
  if (!generated) return [link];
  if (generated.kind === "link") return generated.linkTarget === target ? [] : [{ kind: "unlink", name: real.name }, link];
  if (generated.kind === "file" && real.kind === "file") return [planReplacedFile(real, target, inputs.sourceStamps[fileStampKey(real.name)]), link];
  if (generated.kind !== "folder" || real.kind !== "folder") return "private";
  const adoption = planPrivateFolder(real, generated, target);
  return adoption === "private" ? adoption : [adoption, link];
}

function isKeptOutOfLinks(name: string, inputs: AgentHomeInputs): boolean {
  return GENERATED_ONLY_NAMES.has(name) || inputs.profile.isPrivateEntryName(name, inputs.platform);
}

function planAgentHome(inputs: AgentHomeInputs): AgentHomePlan {
  const config = generatedAgentConfig(inputs);
  if ("refusal" in config) return { kind: "refused", reason: `the real ${AGENT_HOME_CONFIG_NAME} cannot take the hooks block: ${config.refusal}` };
  const steps: AgentHomeStep[] = [];
  if (config.text !== inputs.generatedConfigText) steps.push({ kind: "write-config", text: config.text });
  if (config.base !== inputs.baseConfigText) steps.push({ kind: "write-base", text: config.base });
  const generatedByName = new Map(inputs.generatedEntries.map((entry) => [entry.name, entry]));
  const realNames = new Set<string>();
  const privateNames: string[] = [];
  for (const real of inputs.realEntries) {
    if (isKeptOutOfLinks(real.name, inputs)) continue;
    realNames.add(real.name);
    const entrySteps = planEntryLink(real, generatedByName.get(real.name), inputs);
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
    privateNames,
    hasStaleBlockInRealConfig: config.hadBlock,
  };
}

const KIMI_HOME_PROFILE: AgentHomeProfile = Object.freeze({
  vendor: "kimi",
  homeEnvName: "KIMI_CODE_HOME",
  defaultHomeFolderName: ".kimi-code",
  hooksConflict: (operatorText: string) => definesHooksOutsideArrayTables(operatorText) ? "it defines hooks as a key or [hooks] table, which a [[hooks]] block cannot extend" : null,
  sessionOnlyTablePrefixes: Object.freeze(["[[hooks#"]),
  isPrivateEntryName: () => false,
});

const CODEX_HOOK_HANDLER_TABLE_HEADER_PATTERN = /^\s*\[(?!\[)\s*hooks\s*(?:\]|\.(?!\s*state\s*[\].]))/;
const CODEX_SQLITE_NAME_PATTERN = /\.sqlite(?:-wal|-shm|-journal)?$/;

function definesCodexHooksOutsideArrayTables(operatorText: string): boolean {
  let isAtTopLevel = true;
  for (const line of operatorText.split("\n")) {
    if (CODEX_HOOK_HANDLER_TABLE_HEADER_PATTERN.test(line)) return true;
    if (TABLE_HEADER_PATTERN.test(line)) isAtTopLevel = false;
    if (isAtTopLevel && TOP_LEVEL_HOOKS_KEY_PATTERN.test(line)) return true;
  }
  return false;
}

const CODEX_HOME_PROFILE: AgentHomeProfile = Object.freeze({
  vendor: "codex",
  homeEnvName: "CODEX_HOME",
  defaultHomeFolderName: ".codex",
  hooksConflict: (operatorText: string) => definesCodexHooksOutsideArrayTables(operatorText) ? "it defines hooks as a key or a [hooks] table other than [hooks.state], which [[hooks.<event>]] tables cannot extend" : null,
  sessionOnlyTablePrefixes: Object.freeze(["[[hooks.", "[hooks.state."]),
  isPrivateEntryName: (name: string, platform: NodeJS.Platform) => platform === "win32" && CODEX_SQLITE_NAME_PATTERN.test(name),
});

interface CodexHomeHook {
  event: string;
  matcher: string | null;
  command: string;
}

function codexHookTables(hook: CodexHomeHook): string[] {
  const lines = [`[[hooks.${hook.event}]]`];
  if (hook.matcher !== null) lines.push(`matcher = '${hook.matcher}'`);
  lines.push(`[[hooks.${hook.event}.hooks]]`, `type = "command"`, `command = '${hook.command}'`);
  return lines;
}

function renderCodexHookTables(hooks: readonly CodexHomeHook[]): string {
  return `${hooks.flatMap(codexHookTables).join("\n")}\n`;
}

function tomlBasicString(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function hookEventKeyLabel(event: string): string {
  return event.replaceAll(/(?<=[a-z0-9])([A-Z])/g, "_$1").toLowerCase();
}

function codexOperatorGroupCount(operatorText: string, event: string): number {
  const groupIdPrefix = `[[hooks.${event}#`;
  return splitTomlUnits(operatorText).tables.filter((unit) => unit.id.startsWith(groupIdPrefix)).length;
}

const CODEX_HOOK_STATE_HEADER_PATTERN = /^\s*\[\s*hooks\s*\.\s*state\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*\]\s*$/;

function hookStateKeyOf(headerLine: string): string | null {
  const match = CODEX_HOOK_STATE_HEADER_PATTERN.exec(headerLine.replace(/\r$/, ""));
  if (!match) return null;
  if (match[2] !== undefined) return match[2];
  return (match[1] ?? "").replaceAll(/\\(["\\])/g, "$1");
}

function hookStateTable(key: string, bodyLines: readonly string[]): string[] {
  return [`[hooks.state.${tomlBasicString(key)}]`, ...bodyLines];
}

function rekeyedOperatorTrust(operatorText: string, realHome: string, generatedHome: string, ownKeys: ReadonlySet<string>): string[] {
  const realPrefix = `${realHome}${path.sep}`;
  const stateTables = splitTomlUnits(operatorText).tables.flatMap((unit) => {
    const [headerLine = "", ...bodyLines] = unit.text.split("\n");
    const key = hookStateKeyOf(headerLine);
    if (key === null) return [];
    return [{ key, bodyLines: bodyLines.map((line) => line.replace(/\r$/, "")).filter((line) => line.trim() !== "") }];
  });
  const knownKeys = new Set([...ownKeys, ...stateTables.map((table) => table.key)]);
  return stateTables.flatMap(({ key, bodyLines }) => {
    if (!key.startsWith(realPrefix)) return [];
    const rekeyed = `${generatedHome}${path.sep}${key.slice(realPrefix.length)}`;
    if (knownKeys.has(rekeyed)) return [];
    knownKeys.add(rekeyed);
    return hookStateTable(rekeyed, bodyLines);
  });
}

interface CodexHooksBlockOptions {
  hooks: readonly CodexHomeHook[];
  trustedHashes: readonly string[] | null;
  operatorText: string;
  realHome: string;
  generatedHome: string;
}

interface HookStateEntry {
  key: string;
  bodyLines: string[];
}

function ownHookTrust(options: CodexHooksBlockOptions): HookStateEntry[] {
  const trustedHashes = options.trustedHashes;
  if (trustedHashes === null) return [];
  const configPath = path.join(options.generatedHome, AGENT_HOME_CONFIG_NAME);
  const nextGroupIndexByEvent = new Map<string, number>();
  return options.hooks.flatMap((hook, hookIndex) => {
    const groupIndex = nextGroupIndexByEvent.get(hook.event) ?? codexOperatorGroupCount(options.operatorText, hook.event);
    nextGroupIndexByEvent.set(hook.event, groupIndex + 1);
    const trustedHash = trustedHashes[hookIndex];
    if (trustedHash === undefined) return [];
    return [{ key: `${configPath}:${hookEventKeyLabel(hook.event)}:${groupIndex}:0`, bodyLines: [`trusted_hash = ${tomlBasicString(trustedHash)}`] }];
  });
}

function renderCodexHooksBlock(options: CodexHooksBlockOptions): string {
  const ownTrust = ownHookTrust(options);
  const lines = [
    BLOCK_START,
    ...options.hooks.flatMap(codexHookTables),
    ...ownTrust.flatMap(({ key, bodyLines }) => hookStateTable(key, bodyLines)),
    ...rekeyedOperatorTrust(options.operatorText, options.realHome, options.generatedHome, new Set(ownTrust.map(({ key }) => key))),
    BLOCK_END,
  ];
  return `${lines.join("\n")}\n`;
}

export {
  AGENT_HOME_BASE_NAME,
  AGENT_HOME_CONFIG_NAME,
  AGENT_HOME_CONFLICTS_NAME,
  AGENT_HOME_IN_USE_LOCK_NAME,
  AGENT_HOME_SOURCES_NAME,
  BLOCK_END,
  BLOCK_START,
  CODEX_HOME_PROFILE,
  KIMI_HOME_PROFILE,
  fileStampKey,
  planAgentHome,
  renderCodexHookTables,
  renderCodexHooksBlock,
  renderKimiHooksBlock,
};
export type { AgentHomePlan, AgentHomeProfile, AgentHomeStep, CodexHomeHook, GeneratedAgentHomeEntry, RealAgentHomeEntry };
