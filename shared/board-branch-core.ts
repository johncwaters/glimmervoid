export const BRANCH_PROMPT_PREFIX = 'You are a branch of the session ';
const OPERATOR_PART_MARKER = ' The operator asks: ';

export function branchPromptOf(orchestratorName: string, repoName: string, aboutTitle: string, operatorPrompt: string): string {
  return `${BRANCH_PROMPT_PREFIX}${orchestratorName}, working in ${repoName} on ${aboutTitle}. Commit your work on this branch.${OPERATOR_PART_MARKER}${operatorPrompt}`;
}

export function operatorPartOfPrompt(promptText: string): string {
  if (!promptText.startsWith(BRANCH_PROMPT_PREFIX)) return promptText;
  const markerIndex = promptText.indexOf(OPERATOR_PART_MARKER);
  if (markerIndex < 0) return promptText;
  return promptText.slice(markerIndex + OPERATOR_PART_MARKER.length);
}

export const REPO_ROOT_BRANCH_TITLE = 'repo root';

export type BranchAbout = { boxId: string } | { repoPath: string };
export type BranchTarget = { ok: true; boxId: string; title: string } | { ok: false; error: string };

function folderPrefixOf(aboutTitle: string): string {
  return aboutTitle === REPO_ROOT_BRANCH_TITLE ? '' : `${aboutTitle.replace(/\/+$/, '')}/`;
}

function isInsideBranchFolder(repoPath: string, aboutTitle: string): boolean {
  return repoPath.startsWith(folderPrefixOf(aboutTitle));
}

export function overlappingBranchTitle(aboutTitle: string, liveBranchTitles: readonly string[]): string | null {
  const wantedPrefix = folderPrefixOf(aboutTitle);
  return liveBranchTitles.find((liveTitle) => {
    const livePrefix = folderPrefixOf(liveTitle);
    return livePrefix.startsWith(wantedPrefix) || wantedPrefix.startsWith(livePrefix);
  }) ?? null;
}

export function pathsOutsideBranchFolder(repoPaths: readonly string[], aboutTitle: string): string[] {
  return repoPaths.filter((repoPath) => !isInsideBranchFolder(repoPath, aboutTitle));
}
