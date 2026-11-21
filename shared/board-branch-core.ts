export const BRANCH_PROMPT_PREFIX = 'You are a branch of the session ';
const OPERATOR_PART_MARKER = ' The operator asks: ';

export function branchPromptOf(parentName: string, aboutTitle: string, operatorPrompt: string): string {
  return `${BRANCH_PROMPT_PREFIX}${parentName}, started from its last commit to work on ${aboutTitle}. Commit your work on this branch; Glimmervoid brings your commits into ${parentName} when you go idle.${OPERATOR_PART_MARKER}${operatorPrompt}`;
}

export function operatorPartOfPrompt(promptText: string): string {
  if (!promptText.startsWith(BRANCH_PROMPT_PREFIX)) return promptText;
  const markerIndex = promptText.indexOf(OPERATOR_PART_MARKER);
  if (markerIndex < 0) return promptText;
  return promptText.slice(markerIndex + OPERATOR_PART_MARKER.length);
}
