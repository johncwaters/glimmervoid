import { maskSecrets } from '#shared/secret-patterns.ts';

const HOME_NAME = '[^/\\\\\\s"\'`<>:]+';
const HOME_DIR_PATTERN = new RegExp(`(?<![\\w./\\\\-])(?:/home/${HOME_NAME}|/Users/${HOME_NAME}|[A-Za-z]:[\\\\/]Users[\\\\/]${HOME_NAME}|/root(?![\\w.-]))`, 'g');

function collapseHomeDirs(text: string): string {
  return text.replace(HOME_DIR_PATTERN, '~');
}

export function maskStreamerText(text: string): string {
  return collapseHomeDirs(maskSecrets(text));
}
