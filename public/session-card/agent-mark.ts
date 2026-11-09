import claudeCodeIcon from '../agent-icons/claude-code.svg?raw';
import codexIcon from '../agent-icons/codex.svg?raw';
import copilotIcon from '../agent-icons/copilot.svg?raw';
import cursorIcon from '../agent-icons/cursor.svg?raw';
import geminiIcon from '../agent-icons/gemini.svg?raw';
import gooseIcon from '../agent-icons/goose.svg?raw';
import grokIcon from '../agent-icons/grok.svg?raw';
import kimiIcon from '../agent-icons/kimi.svg?raw';
import opencodeIcon from '../agent-icons/opencode.svg?raw';
import qwenIcon from '../agent-icons/qwen.svg?raw';
import { agentBrandColorReference } from '../agent-brand-colors.ts';
import { monogramFor } from '../avatar-core.ts';
import { SHELL_AGENT_ID } from './agent-core.ts';
import { createLineIcon, TERMINAL_ICON_PATH } from '../svg-dom.ts';

const AGENT_ICON_SVG_BY_ID: ReadonlyMap<string, string> = new Map([
  ['claude-code', claudeCodeIcon],
  ['codex', codexIcon],
  ['copilot', copilotIcon],
  ['cursor', cursorIcon],
  ['gemini', geminiIcon],
  ['goose', gooseIcon],
  ['grok', grokIcon],
  ['kimi', kimiIcon],
  ['opencode', opencodeIcon],
  ['qwen', qwenIcon],
]);

export function paintAgentMark(markEl: HTMLElement, agentId: string | null, agentLabel: string | null = null) {
  const shownAgentId = agentId === SHELL_AGENT_ID ? null : agentId;
  if (markEl.dataset.agent === (shownAgentId ?? '')) return;
  markEl.dataset.agent = shownAgentId ?? '';
  markEl.hidden = shownAgentId === null;
  if (shownAgentId === null) {
    markEl.replaceChildren();
    markEl.style.removeProperty('--agent-brand');
    return;
  }
  markEl.style.setProperty('--agent-brand', agentBrandColorReference(shownAgentId));
  const iconSvg = AGENT_ICON_SVG_BY_ID.get(shownAgentId);
  markEl.toggleAttribute('data-monogram', iconSvg === undefined);
  if (iconSvg !== undefined) {
    markEl.innerHTML = iconSvg;
    return;
  }
  markEl.textContent = monogramFor(agentLabel ?? shownAgentId);
}

export function paintAgentChoiceMark(markEl: HTMLElement, agentId: string | null, agentLabel: string | null = null) {
  if (agentId !== SHELL_AGENT_ID) return paintAgentMark(markEl, agentId, agentLabel);
  if (markEl.dataset.agent === SHELL_AGENT_ID) return;
  markEl.dataset.agent = SHELL_AGENT_ID;
  markEl.hidden = false;
  markEl.removeAttribute('data-monogram');
  markEl.style.removeProperty('--agent-brand');
  markEl.replaceChildren(createLineIcon(TERMINAL_ICON_PATH));
}
