const RELAY_NEWS_SUFFIX = ', the session you spawned, has news.';
export const SIBLING_MESSAGE_LINE = 'Glimmervoid: the session that spawned you, or a sibling it spawned, sent a message. Run glimmervoid read and act on it.';
const PARENT_MESSAGE_LINE_BEFORE_SIBLINGS = 'Glimmervoid: the session that spawned you sent a message. Run glimmervoid read and act on it.';
const WAKE_LINE_PATTERN = /^Glimmervoid wake (\S+) \(([^)]*)\): ([\s\S]*)$/;
const RELAY_LINE_PATTERN = /^Glimmervoid: (.+), the session you spawned, has news\. Run glimmervoid read \S+ and act on it\.$/;
const TASK_NOTIFICATION_PATTERN = /^<task-notification\b[^>]*>([\s\S]*?)<\/task-notification\b[^>]*>/i;
const TASK_SUMMARY_PATTERN = /<summary>([\s\S]*?)<\/summary>/i;
const XML_ENTITY_PATTERN = /&(amp|lt|gt|quot|apos|#39);/g;
const CHARACTER_BY_XML_ENTITY: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

export function relayNewsLine(childName: string, childId: string): string {
  return `Glimmervoid: ${childName}${RELAY_NEWS_SUFFIX} Run glimmervoid read ${childId} and act on it.`;
}

export function wakeLine(wakeId: string, origin: string, text: string): string {
  return `Glimmervoid wake ${wakeId} (${origin}): ${text}`;
}

function firstLineOf(text: string): string {
  return text.trim().split('\n', 1)[0]?.trim() ?? '';
}

function decodedXmlText(text: string): string {
  return text.replace(XML_ENTITY_PATTERN, (_entity, name: string) => CHARACTER_BY_XML_ENTITY[name] ?? '');
}

export function glimmervoidLineLabelOf(promptText: string): string | null {
  const trimmed = promptText.trim();
  const relay = RELAY_LINE_PATTERN.exec(trimmed);
  if (relay !== null) return `${relay[1]} has news`;
  if (trimmed === SIBLING_MESSAGE_LINE || trimmed === PARENT_MESSAGE_LINE_BEFORE_SIBLINGS) return 'A message from the session that spawned you or a sibling';
  const wake = WAKE_LINE_PATTERN.exec(trimmed);
  if (wake !== null) return `Wake: ${firstLineOf(wake[3] ?? '')}`;
  return null;
}

export function taskNotificationLabelOf(expansionText: string): string | null {
  const envelope = TASK_NOTIFICATION_PATTERN.exec(expansionText.trim());
  if (envelope === null) return null;
  const summary = firstLineOf(decodedXmlText(TASK_SUMMARY_PATTERN.exec(envelope[1] ?? '')?.[1] ?? ''));
  return summary === '' ? 'Background task finished' : summary;
}
