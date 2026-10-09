const GH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NODE_ID_RE = /^[A-Za-z0-9_=-]+$/;

function repoParts(repo: string): [string, string] | null {
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts.every((part) => GH_SEGMENT.test(part))) return null;
  return [parts[0], parts[1]];
}

export { GH_SEGMENT, NODE_ID_RE, REPO_SLUG_RE, repoParts };
