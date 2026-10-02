import { TASK_TITLE_CONTROL_CHARACTERS, TASK_TITLE_MAX_LENGTH } from '../../shared/contracts/session.ts';

export interface TaskTitleSources {
  customTitle?: string | null;
  aiTitle?: string | null;
  oscTitle?: string | null;
  promptTitle?: string | null;
}

export interface TaskTitleVocabulary {
  readsTranscriptTitle: boolean;
  genericTitles: readonly string[];
  agentSuffix: string | null;
}

export function normalizeTaskTitle(title: string): string | null {
  return title.replace(new RegExp(TASK_TITLE_CONTROL_CHARACTERS.source, 'g'), ' ').replace(/\s+/g, ' ').trim().slice(0, TASK_TITLE_MAX_LENGTH).trimEnd() || null;
}

export function extractAiTitle(tail: string, hasPartialFirstLine = false): string | null {
  const lines = tail.split('\n');
  if (hasPartialFirstLine) lines.shift();
  for (let index = lines.length - 1; index >= 0; index--) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (!('type' in entry) || entry.type !== 'ai-title') continue;
    if (!('aiTitle' in entry) || typeof entry.aiTitle !== 'string') continue;
    const title = normalizeTaskTitle(entry.aiTitle);
    if (title) return title;
  }
  return null;
}

export function extractOscTaskTitle(title: string, cwdBasename: string, vocabulary: TaskTitleVocabulary): string | null {
  const withoutPrefix = title.replace(/^[\s\p{S}\u2800-\u28ff]+/u, '').replace(/^\[[^\]]*\]\s*(?:[^|]*\|\s*)?/, '').trim();
  const suffix = vocabulary.agentSuffix;
  const withoutSuffix = suffix && withoutPrefix.toLowerCase().endsWith(suffix.toLowerCase())
    ? withoutPrefix.slice(0, -suffix.length)
    : withoutPrefix;
  const taskTitle = normalizeTaskTitle(withoutSuffix);
  if (!taskTitle) return null;
  const genericTitles = [cwdBasename, ...vocabulary.genericTitles].map((name) => name.toLowerCase());
  if (genericTitles.includes(taskTitle.toLowerCase())) return null;
  return taskTitle;
}

export function extractPromptTaskTitle(prompt: unknown): string | null {
  if (typeof prompt !== 'string') return null;
  const collapsed = prompt.replace(/\s+/g, ' ').trim();
  if (!collapsed || collapsed.startsWith('/')) return null;
  if (collapsed.length <= 60) return normalizeTaskTitle(collapsed);
  const prefix = collapsed.slice(0, 57);
  const wordBoundary = collapsed[57] === ' ' ? prefix.length : prefix.lastIndexOf(' ');
  return `${prefix.slice(0, wordBoundary > 0 ? wordBoundary : prefix.length).trimEnd()}...`;
}

export function resolveTaskTitle(sources: TaskTitleSources): { taskTitle: string | null; isCustom: boolean } {
  for (const [title, isCustom] of [
    [sources.customTitle, true], [sources.aiTitle, false], [sources.oscTitle, false], [sources.promptTitle, false],
  ] as const) {
    if (!title) continue;
    const taskTitle = normalizeTaskTitle(title);
    if (taskTitle) return { taskTitle, isCustom };
  }
  return { taskTitle: null, isCustom: false };
}
