const RELEASE_VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

interface ReleaseVersion {
  core: [number, number, number];
  isPrerelease: boolean;
}

function parseReleaseVersion(version: unknown): ReleaseVersion | null {
  if (typeof version !== 'string') return null;
  const matched = RELEASE_VERSION_RE.exec(version.trim());
  if (!matched) return null;
  return {
    core: [Number(matched[1]), Number(matched[2]), Number(matched[3])],
    isPrerelease: matched[4] !== undefined,
  };
}

export function compareReleaseVersions(a: unknown, b: unknown): number {
  const left = parseReleaseVersion(a);
  const right = parseReleaseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return Math.sign(left.core[i] - right.core[i]);
  }
  return Number(right.isPrerelease) - Number(left.isPrerelease);
}
