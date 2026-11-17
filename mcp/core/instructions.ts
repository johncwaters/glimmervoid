const SERVER_INSTRUCTIONS = [
  'Glimmervoid supervises this session and shows it to the operator on a dashboard.',
  'The session tool can spawn a supervised session with its own dashboard card the operator can watch and its own worktree, an option beside an in-process subagent.',
  'Use the whiteboard tool to draw a diagram, architecture map or plan the operator can see and edit, rather than drawing one in chat.',
  'Use show to put an image, video or HTML page you made in front of the operator as a card on a whiteboard, rather than publishing an artifact, pasting it into chat or asking the operator to open the file.',
  'Use push to land this session\'s commits when a plain git push is refused, attention to ask the operator for a decision, review for team pull request reviews, and settings to read Glimmervoid\'s settings.',
  'session limits reports what this session may do.',
  'Use memory to keep a fact later sessions in this project should know and to read what earlier sessions kept.',
].join(' ');

function serverInstructionsWith(operatorRules: readonly string[]): string {
  const ruleLines = operatorRules.map((rule) => rule.trim()).filter((rule) => rule.length > 0).map((rule) => `- ${rule}`);
  if (ruleLines.length === 0) return SERVER_INSTRUCTIONS;
  return `${SERVER_INSTRUCTIONS}\n\nThe operator's rules for every session:\n${ruleLines.join('\n')}`;
}

export { serverInstructionsWith };
