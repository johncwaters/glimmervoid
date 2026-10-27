const RELEASE_VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-next\.(\d+))?$/;

interface ReleaseVersion {
  core: [number, number, number];
  experimentalBuildNumber: number | null;
}

export function parseReleaseVersion(version: unknown): ReleaseVersion | null {
  if (typeof version !== 'string') return null;
  const matched = RELEASE_VERSION_RE.exec(version.trim());
  if (!matched) return null;
  return {
    core: [Number(matched[1]), Number(matched[2]), Number(matched[3])],
    experimentalBuildNumber: matched[4] === undefined ? null : Number(matched[4]),
  };
}

function compareExperimentalBuildNumbers(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return Math.sign(a - b);
}

export function compareReleaseVersions(a: unknown, b: unknown): number {
  const left = parseReleaseVersion(a);
  const right = parseReleaseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return Math.sign(left.core[i] - right.core[i]);
  }
  return compareExperimentalBuildNumbers(left.experimentalBuildNumber, right.experimentalBuildNumber);
}

export function isExperimentalBuild(version: unknown): boolean {
  const parsed = parseReleaseVersion(version);
  return parsed !== null && parsed.experimentalBuildNumber !== null;
}
