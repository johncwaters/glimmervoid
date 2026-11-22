import crypto from 'node:crypto';
import { TASK_TITLE_CONTROL_CHARACTERS, TASK_TITLE_MAX_LENGTH } from '../../shared/contracts/session.ts';
import { unwrapPastedContent } from '../../shared/pasted-content.ts';
import { firstCodePoints } from '../../shared/text.ts';

const envelopePattern = (tag: string) => new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\b[^>]*>`, 'gi');
export const TASK_NOTIFICATION_ENVELOPE_PATTERN = envelopePattern('task-notification');
const PROMPT_ENVELOPE_PATTERNS = [envelopePattern('system-reminder'), TASK_NOTIFICATION_ENVELOPE_PATTERN];

export function normalizeTaskTitle(title: string): string | null {
  const collapsedTitle = title.replace(new RegExp(TASK_TITLE_CONTROL_CHARACTERS.source, 'g'), ' ').replace(/\s+/g, ' ').trim();
  return firstCodePoints(collapsedTitle, TASK_TITLE_MAX_LENGTH).trimEnd() || null;
}

export function cleanTaskPrompt(prompt: string): string {
  let cleanedPrompt = unwrapPastedContent(prompt);
  for (const pattern of PROMPT_ENVELOPE_PATTERNS) cleanedPrompt = cleanedPrompt.replace(pattern, ' ');
  return cleanedPrompt.replace(/\s+/g, ' ').trim();
}

export function extractPromptTaskTitle(prompt: unknown): string | null {
  if (typeof prompt !== 'string') return null;
  const collapsed = cleanTaskPrompt(prompt);
  if (!collapsed || collapsed.startsWith('/')) return null;
  const promptCodePoints = Array.from(collapsed);
  if (promptCodePoints.length <= 60) return normalizeTaskTitle(collapsed);
  const prefix = promptCodePoints.slice(0, 57).join('');
  const wordBoundary = promptCodePoints[57] === ' ' ? prefix.length : prefix.lastIndexOf(' ');
  return `${prefix.slice(0, wordBoundary > 0 ? wordBoundary : prefix.length).trimEnd()}...`;
}

export function fencedUntrustedSections(sections: readonly (readonly [label: string, body: string])[]): string[] {
  return sections.flatMap(([label, body]) => {
    const digest = crypto.createHash('sha256').update(body, 'utf8').digest('hex').toUpperCase();
    const marker = `GLIMMERVOID-${label}-${digest}`;
    return [`BEGIN_${marker}`, body, `END_${marker}`];
  });
}

function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function startsWithSessionName(title: string, sessionName: string): boolean {
  const titleWords = wordsOf(title);
  const nameWords = wordsOf(sessionName);
  if (nameWords.length === 0) return false;
  return nameWords.every((nameWord, index) => titleWords[index] === nameWord);
}
