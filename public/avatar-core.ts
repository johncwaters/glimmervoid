export function avatarUrlForLogin(login: string, cssPx: number): string | null {
  if (!login || login.toLowerCase().endsWith('[bot]')) return null;
  return `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=${cssPx * 2}`;
}

export function monogramFor(login: string): string {
  return login.match(/[a-z0-9]/i)?.[0]?.toUpperCase() ?? '?';
}
