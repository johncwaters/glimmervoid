import type { APIRoute } from 'astro';
import { AGENT_COMMAND_HELP } from '../../../server/core/agent-api-core.ts';
import { agentMarkdownPage, markdownResponse } from '../lib/agent-markdown.ts';
import { INSTALL_COMMAND, LINUX_INSTALL_COMMAND } from '../lib/install-command.ts';
import { AGENT_CARDS, DEFAULT_PORT, GUARDED_AGENT_LABELS, MINIMUM_NODE_VERSION, PRODUCT_VERSION, REPOSITORY_URL } from '../lib/product-facts.ts';
import { sitePath } from '../lib/site-path.ts';

export const GET: APIRoute = ({ site }) => {
  const urlOf = (pathWithinSite: string) => new URL(sitePath(pathWithinSite), site).href;
  const body = [
    `Glimmervoid is a local orchestrator for coding agents. A small Node.js process on your own machine starts each agent as a real process in a real terminal, with your own login and settings, gives each session its own git worktree, and serves a browser dashboard that shows which session needs you. It never sits between an agent and its model. It binds to localhost, needs no account, and is open source under MIT. Current version: ${PRODUCT_VERSION}.`,
    '## Install',
    [
      `- Windows and macOS: \`${INSTALL_COMMAND}\``,
      `- Linux: \`${LINUX_INSTALL_COMMAND}\``,
      `- Needs Node ${MINIMUM_NODE_VERSION}. The dashboard opens at http://localhost:${DEFAULT_PORT}. Ctrl+C stops the server. The same command updates.`,
      '- `glimmervoid doctor` checks PATH, agent CLIs and node-pty. `glimmervoid pair` links a phone.',
    ].join('\n'),
    '## Supported agents',
    [
      ...AGENT_CARDS.map(({ label, support }) => `- ${label}: ${support}`),
      '- Any other agent CLI that runs in a terminal can be declared in the config.',
    ].join('\n'),
    '## Features',
    [
      '- Status: read from each agent\'s own lifecycle hooks, with the terminal title as a fallback, never from reading the screen. Sessions waiting on you collect in a "needs you" queue, and Cmd+J jumps to the next one.',
      '- Worktrees: every session in a git repo runs in its own git worktree, so parallel agents never collide. One click merges a session\'s work back; a conflict goes back to the agent that wrote the code.',
      '- Reviews: your team\'s pull requests are reviewed in a guarded session and you post the parts you agree with. Your own pull requests merge once they are ready. Opening GitHub is not required.',
      '- Helper agents: every session gets the `glimmervoid` CLI, so an agent can spawn a helper session, message it, and close it.',
      `- Guardrails: accident protection, not a security boundary, for ${GUARDED_AGENT_LABELS} on macOS and Linux. Safe commands run without prompts; destructive ones such as \`git reset --hard\` are blocked.`,
      '- Remote: one machine hosts everything; a phone or other device pairs once with a single-use link over your own HTTPS proxy, such as Tailscale.',
      '- Notifications: browser notifications, or Telegram when no dashboard tab is open.',
      '- Plan review: approve an agent\'s plan from any device.',
      '- Auto-resume: sessions that were live when Glimmervoid stopped come back on the next start, mid-turn included.',
      '- Streamer mode: hides secrets on screen.',
      '- Conversation view (experimental): read a session like a chat.',
    ].join('\n'),
    '## Commands inside a session',
    Object.values(AGENT_COMMAND_HELP).map(({ usage, summary }) => `- \`glimmervoid ${usage}\`: ${summary}`).join('\n'),
    '## Links',
    [
      `- Source: ${REPOSITORY_URL}`,
      '- npm: https://www.npmjs.com/package/glimmervoid',
      `- Changelog: ${REPOSITORY_URL}/blob/main/CHANGELOG.md`,
      `- Blog: ${urlOf('blog/')}`,
    ].join('\n'),
  ].join('\n\n');
  return markdownResponse(agentMarkdownPage({ title: 'Glimmervoid', pageUrl: urlOf(''), indexUrl: urlOf('llms.txt'), body }));
};
