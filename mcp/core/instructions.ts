const SERVER_INSTRUCTIONS = [
  'Glimmervoid supervises this session and shows it to the operator on a dashboard.',
  'Use the session tool to spawn work that edits files or runs long: the spawned session gets its own dashboard card the operator can watch, where an in-process subagent stays fine only for a quick read-only lookup.',
  'Use the whiteboard tool to draw a diagram, architecture map or plan the operator can see and edit, rather than drawing one in chat.',
  'Use push to land this session\'s commits when a plain git push is refused, attention to ask the operator for a decision, review for team pull request reviews, and settings to read Glimmervoid\'s settings.',
  'session limits reports what this session may do.',
].join(' ');

export { SERVER_INSTRUCTIONS };
