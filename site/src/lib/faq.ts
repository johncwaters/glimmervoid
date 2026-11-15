import { CODING_AGENT_LABELS } from './product-facts.ts';

export interface FaqEntry {
  question: string;
  answerParagraphs: readonly string[];
}

export const FAQ_ENTRIES: readonly FaqEntry[] = [
  {
    question: 'What is an agentic development environment (ADE)?',
    answerParagraphs: [
      'A workspace built around AI coding agents instead of a code editor.',
      'Agents run in parallel, each in its own git worktree. You review their diffs and merge.',
      'Glimmervoid is an open-source ADE for terminal coding agents.',
    ],
  },
  {
    question: 'What does an agent put on a board?',
    answerParagraphs: [
      'Whatever it would otherwise describe in text: UI prototypes on a phone or laptop, architecture diagrams, plans, screenshots, clips and docs.',
      'You answer by dragging a box, drawing or leaving a sticky note. The agent sees it on its next prompt.',
    ],
  },
  {
    question: 'Which coding agents does Glimmervoid run?',
    answerParagraphs: [
      `${CODING_AGENT_LABELS} are built in.`,
      'Any other agent CLI that runs in a terminal can be added in the config.',
    ],
  },
  {
    question: 'Is Glimmervoid free, and does my code leave my machine?',
    answerParagraphs: [
      'Free and open source under MIT, with no account.',
      'It runs on your machine and binds to localhost.',
      'Each agent talks straight to its own provider with your login. Glimmervoid never sits in between.',
    ],
  },
  {
    question: 'How is an ADE different from an IDE or a terminal multiplexer?',
    answerParagraphs: [
      'An IDE is built around you editing files. An ADE is built around agents editing while you answer, review and merge.',
      'A multiplexer gives you a grid to watch. Glimmervoid reads each agent\'s status from its hooks and queues the ones that need you.',
    ],
  },
];
