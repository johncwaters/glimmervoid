const NEW_WORK_ISOLATION_FLOOR = Object.freeze({ major: 2, minor: 48 });
const NEW_WORK_ISOLATION_FLOOR_LABEL = `${NEW_WORK_ISOLATION_FLOOR.major}.${NEW_WORK_ISOLATION_FLOOR.minor}`;

const WHOLE_RANGE_CONSEQUENCE = 'a team re-review cannot single out the author\'s new work and reviews the whole pull request range';
const GIT_UPDATE_HINT = `Update git to ${NEW_WORK_ISOLATION_FLOOR_LABEL} or newer`;

interface GitVersionReport {
  version: string | null;
  isTooOldToIsolateNewWork: boolean;
}

const UNKNOWN_GIT_VERSION: GitVersionReport = Object.freeze({ version: null, isTooOldToIsolateNewWork: false });

function gitVersionReport(versionOutput: string | null): GitVersionReport {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(versionOutput?.trim() ?? '');
  if (!match) return UNKNOWN_GIT_VERSION;
  const [, major = '', minor = '', patch] = match;
  const isBelowFloorMajor = Number(major) < NEW_WORK_ISOLATION_FLOOR.major;
  const isBelowFloorMinor = Number(major) === NEW_WORK_ISOLATION_FLOOR.major && Number(minor) < NEW_WORK_ISOLATION_FLOOR.minor;
  return {
    version: [major, minor, patch].filter((part) => part !== undefined).join('.'),
    isTooOldToIsolateNewWork: isBelowFloorMajor || isBelowFloorMinor,
  };
}

function gitBootWarning(report: GitVersionReport): string | null {
  if (!report.isTooOldToIsolateNewWork) return null;
  return `[git] git ${report.version} is older than ${NEW_WORK_ISOLATION_FLOOR_LABEL}, so ${WHOLE_RANGE_CONSEQUENCE}. ${GIT_UPDATE_HINT}.`;
}

function gitDoctorRows(report: GitVersionReport): [string, string][] {
  const versionRow: [string, string] = ['git', report.version ?? 'unknown'];
  if (!report.isTooOldToIsolateNewWork) return [versionRow];
  return [versionRow, ['hint', `${GIT_UPDATE_HINT}: on an older one ${WHOLE_RANGE_CONSEQUENCE}`]];
}

export { gitBootWarning, gitDoctorRows, gitVersionReport };
export type { GitVersionReport };
