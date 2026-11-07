import { CODING_AGENT_LABELS } from './product-facts.ts';

export interface FaqEntry {
  question: string;
  answer: string;
}

export const FAQ_ENTRIES: readonly FaqEntry[] = [
  {
    question: 'What is an agentic development environment (ADE)?',
    answer: 'A workspace built around autonomous AI coding agents rather than a code editor. You run several agent tasks in parallel, each in its own git worktree, then review their diffs and merge their pull requests. Glimmervoid is an open-source ADE for terminal coding agents: a local orchestrator that runs each agent in a real terminal and shows you which one needs you.',
  },
  {
    question: 'Which coding agents does Glimmervoid run?',
    answer: `${CODING_AGENT_LABELS} are built in. Any other agent CLI that runs in a terminal can be declared in the config.`,
  },
  {
    question: 'Is Glimmervoid free, and does my code leave my machine?',
    answer: 'It is free and open source under MIT, with no account. Glimmervoid runs on your own machine and binds to localhost. It never sits between an agent and its model: each agent reaches its own provider with your own login and subscription, as it would without Glimmervoid.',
  },
  {
    question: 'How is an ADE different from an IDE or a terminal multiplexer?',
    answer: 'An IDE is built around you editing files; an ADE is built around agents doing the editing while you answer, review and merge. A terminal multiplexer puts every agent in a grid and leaves you to watch them. Glimmervoid reads each agent\'s status from its own hooks, queues the sessions that need you, and merges each worktree back with one click.',
  },
];
