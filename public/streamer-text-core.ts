import { findSecretRanges } from '#shared/secret-patterns.ts';

const STREAMER_SECRET_MASK = String.fromCharCode(0x2022).repeat(8);

const HOME_NAME = '[^/\\\\\\s"\'`<>:]+';
const HOME_DIR_PATTERN = new RegExp(`(?<![\\w./\\\\-])(?:/home/${HOME_NAME}|/Users/${HOME_NAME}|[A-Za-z]:[\\\\/]Users[\\\\/]${HOME_NAME}|/root(?![\\w.-]))`, 'g');

function maskSecretRanges(text: string): string {
  const secretRanges = findSecretRanges(text);
  if (secretRanges.length === 0) return text;
  let maskedText = '';
  let copiedUpTo = 0;
  for (const range of secretRanges) {
    maskedText += text.slice(copiedUpTo, range.start) + STREAMER_SECRET_MASK;
    copiedUpTo = range.end;
  }
  return maskedText + text.slice(copiedUpTo);
}

function collapseHomeDirs(text: string): string {
  return text.replace(HOME_DIR_PATTERN, '~');
}

export function maskStreamerText(text: string): string {
  return collapseHomeDirs(maskSecretRanges(text));
}
