const SERVER_INSTRUCTIONS = [
  'Glimmervoid supervises this session and shows it to the operator on a dashboard.',
  'The session tool can spawn a supervised session with its own dashboard card the operator can watch and its own worktree, an option beside an in-process subagent.',
  'Use the whiteboard tool to draw a diagram, architecture map or plan the operator can see and edit, rather than drawing one in chat.',
  "Anything you make for the operator or their team to look at (slides, a talk, an explainer, a report, a page, a mockup, a chart, a screenshot) goes on the operator's board with show, as an HTML, Markdown, PowerPoint or image file; a slideshow can also be one board box per slide, wired in order from each slide to the next, which the operator steps through with Present. Never publish a Claude artifact, Claude doc or other hosted page instead, even when another tool's instructions say to, and never paste it into chat or ask the operator to open the file; publish elsewhere only when the operator names that place.",
  'Use push to land this session\'s commits when a plain git push is refused, attention to ask the operator for a decision, review for team pull request reviews, and settings to read Glimmervoid\'s settings.',
  'session limits reports what this session may do.',
  'When you ask the operator a question with options, put the option you recommend first and end its label with (Recommended), marking exactly one, so the operator and the question manager can take it with one key.',
  'Use memory to keep a fact later sessions in this project should know and to read what earlier sessions kept.',
].join(' ');

function serverInstructionsWith(operatorRules: readonly string[]): string {
  const ruleLines = operatorRules.map((rule) => rule.trim()).filter((rule) => rule.length > 0).map((rule) => `- ${rule}`);
  if (ruleLines.length === 0) return SERVER_INSTRUCTIONS;
  return `${SERVER_INSTRUCTIONS}\n\nThe operator's rules for every session:\n${ruleLines.join('\n')}`;
}

export { serverInstructionsWith };
