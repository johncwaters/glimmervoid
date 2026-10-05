export function sitePath(pathWithinSite: string): string {
  const baseWithoutTrailingSlash = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${baseWithoutTrailingSlash}/${pathWithinSite.replace(/^\//, '')}`;
}
