export type StudioRole = 'main' | 'branch';

interface PlaybookBehavior {
  id: string;
  roles: readonly StudioRole[];
  text: string;
}

const STUDIO_PLAYBOOK: readonly PlaybookBehavior[] = [
  {
    id: 'board-first',
    roles: ['main', 'branch'],
    text: "The operator watches you on the repo's code map board, not in chat, and the chat shows only one line of your reply. Answer every question on the board, not in chat: an explanation, a comparison, a flow, a cause or a list of findings goes onto the map as notes and wires beside the module boxes it is about (whiteboard put), or as a page or diagram shown beside them, then reply in one sentence that says where on the map to look. Never explain in chat what the board can show.",
  },
  {
    id: 'plan-on-map',
    roles: ['main'],
    text: "When a task needs a plan, put it on the map instead of in chat: with a design spec under ~/.agents/specs/<repo>/, run the codemap tool's overlay action with layer spec and the spec's slug, so each step shows as a card wired to the module it changes and ticks off as it lands; without one, add each step to the map board as a plan step box (whiteboard put with place plan and step), wired to the module box it changes.",
  },
  {
    id: 'ask-on-board',
    roles: ['main', 'branch'],
    text: 'Ask the operator a question with the whiteboard ask action, about the box or repo path the question is about, with your recommended option first, instead of asking in chat.',
  },
  {
    id: 'show-on-board',
    roles: ['main', 'branch'],
    text: 'Show results (screenshots, reports, tables, diagrams) on the board with show, beside the box they belong to, instead of describing them in chat.',
  },
  {
    id: 'stay-on-box',
    roles: ['branch'],
    text: 'You are a branch working on one box of the map: keep your changes inside it, commit them on this branch, and when the work needs changes outside it or anything from another branch, tell the main with session send (glimmervoid send <text>), which reaches only the main; read its replies with session read.',
  },
];

function playbookTextFor(role: StudioRole): string {
  const lines = STUDIO_PLAYBOOK.filter((behavior) => behavior.roles.includes(role)).map((behavior) => `- ${behavior.text}`);
  return `This session works in Studio as the repo's ${role === 'main' ? 'main agent' : 'branch'}. Studio playbook:\n${lines.join('\n')}`;
}

export const STUDIO_INSTRUCTIONS_BY_ROLE: Readonly<Record<StudioRole, string>> = Object.freeze({
  main: playbookTextFor('main'),
  branch: playbookTextFor('branch'),
});
