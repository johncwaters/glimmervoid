import { CODING_AGENT_LABELS, OPENROUTER_AGENT_LABELS } from './product-facts.ts';

export interface FaqEntry {
  question: string;
  answerParagraphs: readonly string[];
}

export const FAQ_ENTRIES: readonly FaqEntry[] = [
  {
    question: 'What is Glimmervoid?',
    answerParagraphs: [
      'Your coding agents draw plans and screens on a shared board you mark up.',
      'Studio runs Claude Code, Codex and Antigravity CLI with no terminal, Focus keeps the terminal when you want it, and Packs add tabs.',
      'Every agent works in its own git worktree, so you answer, review their diffs and merge from one place.',
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
      `${OPENROUTER_AGENT_LABELS} can also run on any model on OpenRouter, picked per session.`,
      'Any other agent CLI that runs in a terminal can be added in the config.',
    ],
  },
  {
    question: 'Is Glimmervoid free, and does my code leave my machine?',
    answerParagraphs: [
      'Free and open source under MIT, with no account.',
      'It runs on your machine and binds to localhost.',
      'Each agent talks straight to its model provider with your own login or API key. Glimmervoid never sits in between.',
      'An OpenRouter key stays in the Vault, and a session reads it only after you approve.',
    ],
  },
  {
    question: 'Do I have to keep my computer on?',
    answerParagraphs: [
      'Only if you run Glimmervoid on it.',
      'Glimmervoid Cloud runs your sessions on a server of your own, so they keep working with your laptop closed, and you open them from any browser or phone.',
      'It is in an invite-only alpha, free while it lasts.',
    ],
  },
  {
    question: 'How is Glimmervoid different from an IDE or a terminal multiplexer?',
    answerParagraphs: [
      'An IDE centers on you editing files by hand. Glimmervoid runs agents in parallel worktrees while you mark up their boards, review diffs and merge.',
      'A multiplexer gives you a grid of terminals to watch. Glimmervoid reads each agent\'s status from its hooks and brings forward the session that needs you.',
    ],
  },
];
