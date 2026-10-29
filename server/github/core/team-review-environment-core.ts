import type { ReviewModelOffer } from '../../../shared/contracts/team-review-environment.ts';

const CLAUDE_EFFORTS: readonly string[] = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const CLAUDE_MODELS: readonly ReviewModelOffer[] = Object.freeze(['opus', 'sonnet', 'haiku'].map((alias) => ({
  id: alias, label: alias[0].toUpperCase() + alias.slice(1), efforts: null, defaultEffort: null,
})));
const FRONTMATTER_FENCE = '---';
const FOLDED_SCALAR = /^[>|][+-]?$/;

interface SkillFrontmatter { name: string; description: string }

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  const isQuoted = trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0];
  return isQuoted ? trimmed.slice(1, -1) : trimmed;
}

function frontmatterLines(markdown: string): string[] | null {
  const lines = markdown.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) return null;
  const closingIndex = lines.indexOf(FRONTMATTER_FENCE, 1);
  if (closingIndex === -1) return null;
  return lines.slice(1, closingIndex);
}

function readFrontmatterValue(lines: string[], key: string): string | null {
  const keyIndex = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (keyIndex === -1) return null;
  const inlineValue = lines[keyIndex].slice(key.length + 1).trim();
  if (!FOLDED_SCALAR.test(inlineValue)) return unquoteYamlScalar(inlineValue);
  const continuation: string[] = [];
  for (const line of lines.slice(keyIndex + 1)) {
    if (!/^\s/.test(line) && line.trim() !== '') break;
    continuation.push(line.trim());
  }
  return continuation.join(' ').trim();
}

function parseSkillFrontmatter(markdown: string): SkillFrontmatter | null {
  const lines = frontmatterLines(markdown);
  if (!lines) return null;
  const name = readFrontmatterValue(lines, 'name');
  if (!name) return null;
  return { name, description: readFrontmatterValue(lines, 'description') ?? '' };
}

function textField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function enabledClaudePluginInstalls(installedPlugins: unknown, settings: unknown): { pluginName: string; installPath: string }[] {
  const pluginsByKey = installedPlugins && typeof installedPlugins === 'object' ? (installedPlugins as Record<string, unknown>).plugins : null;
  const enabledByKey = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).enabledPlugins : null;
  if (!pluginsByKey || typeof pluginsByKey !== 'object' || !enabledByKey || typeof enabledByKey !== 'object') return [];
  return Object.entries(pluginsByKey as Record<string, unknown>).flatMap(([pluginKey, installs]) => {
    if ((enabledByKey as Record<string, unknown>)[pluginKey] !== true || !Array.isArray(installs)) return [];
    const installPath = installs.map((install) => (install && typeof install === 'object' ? textField(install as Record<string, unknown>, 'installPath') : null)).find((candidate) => candidate !== null);
    if (!installPath) return [];
    return [{ pluginName: pluginKey.split('@')[0], installPath }];
  });
}

export {
  CLAUDE_EFFORTS, CLAUDE_MODELS,
  enabledClaudePluginInstalls, parseSkillFrontmatter,
};
