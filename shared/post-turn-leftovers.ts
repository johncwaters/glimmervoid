const REPORT_FOLDER_GIT_PATH = '.glimmervoid/post-turn';
const REPORT_FILE_NAME = /^[a-zA-Z0-9_.-]+\.json$/;
const POWERSHELL_SINGLE_QUOTES = /['\u2018\u2019\u201A\u201B]/g;

interface RepositoryTrackingReports {
  repositoryPath: string;
  trackedReportGitPaths: string[];
}

function isReportGitPath(gitPath: string): boolean {
  const folderPrefix = `${REPORT_FOLDER_GIT_PATH}/`;
  return gitPath.startsWith(folderPrefix) && REPORT_FILE_NAME.test(gitPath.slice(folderPrefix.length));
}

function untrackedReportFileNames(fileNames: readonly string[], trackedGitPaths: readonly string[]): string[] {
  const trackedPaths = new Set(trackedGitPaths);
  return fileNames.filter((fileName) => REPORT_FILE_NAME.test(fileName) && !trackedPaths.has(`${REPORT_FOLDER_GIT_PATH}/${fileName}`));
}

function quoteShellArgument(argument: string, platform: string): string {
  if (platform === 'win32') return `'${argument.replace(POWERSHELL_SINGLE_QUOTES, '$&$&')}'`;
  return `'${argument.replaceAll("'", "'\\''")}'`;
}

function trackedReportCleanupCommands(repositories: readonly RepositoryTrackingReports[], platform: string): string {
  return repositories.map(({ repositoryPath, trackedReportGitPaths }) => {
    const quotedReportPaths = trackedReportGitPaths.map((gitPath) => quoteShellArgument(gitPath, platform)).join(' ');
    return `git -C ${quoteShellArgument(repositoryPath, platform)} rm --cached -q -- ${quotedReportPaths}`;
  }).join('\n');
}

function trackedReportNoticeText(repositoryCount: number): string {
  const repositories = repositoryCount === 1 ? '1 repository' : `${repositoryCount} repositories`;
  return `Git tracks an old Glimmervoid post-turn report in ${repositories}. Nothing reads it, so run this to stop git tracking it and commit the deletion git then shows. Glimmervoid deletes the file itself on its next start:`;
}

export { REPORT_FOLDER_GIT_PATH, isReportGitPath, trackedReportCleanupCommands, trackedReportNoticeText, untrackedReportFileNames };
export type { RepositoryTrackingReports };
