import { BRANCH_PROMPT_MAX_CHARS } from '#shared/contracts/control/board-session-messages.ts';
import { errorMessage } from '#shared/text.ts';
import { createComposer } from '../chat/composer.ts';
import { stringDetailOf } from '../chat/chat-page.ts';
import { el } from '../dom-helpers.ts';

const NO_UPLOADS_URL = '';
const POPOVER_WIDTH_PX = 360;
const EDGE_GAP_PX = 12;

interface NewAgentTarget {
  boxId: string;
  title: string;
}

export interface NewAgentPopover {
  element: HTMLElement;
  open(target: NewAgentTarget, left: number, top: number): void;
  close(): void;
}

export function createNewAgentPopover(spawn: (target: NewAgentTarget, prompt: string) => Promise<string | null>): NewAgentPopover {
  const element = el('section', 'bs-new-agent');
  element.hidden = true;
  const heading = el('h2', 'bs-new-agent-title');
  const failure = el('p', 'bs-failure');
  failure.setAttribute('role', 'status');
  failure.hidden = true;
  const composer = createComposer(() => NO_UPLOADS_URL);
  composer.input.maxLength = BRANCH_PROMPT_MAX_CHARS;
  composer.input.placeholder = 'What should it do?';
  composer.input.setAttribute('aria-label', 'What should the new agent do?');
  element.append(heading, composer.element, failure);
  let shownTarget: NewAgentTarget | null = null;
  let isSpawning = false;

  const showFailure = (failureText: string | null) => {
    failure.hidden = failureText === null;
    failure.textContent = failureText ?? '';
  };

  const settleSpawn = () => {
    isSpawning = false;
    composer.input.disabled = false;
  };

  const close = () => {
    if (isSpawning) return;
    element.hidden = true;
    shownTarget = null;
    composer.restoreDraft('');
    showFailure(null);
  };

  composer.element.addEventListener('chat-send', (event) => {
    const prompt = stringDetailOf(event, 'text');
    const target = shownTarget;
    if (prompt === null || prompt.length === 0 || target === null || isSpawning) return;
    showFailure(null);
    isSpawning = true;
    composer.input.disabled = true;
    spawn(target, prompt)
      .then((failureText) => {
        settleSpawn();
        if (failureText === null) return close();
        composer.restoreDraft(prompt);
        showFailure(failureText);
      })
      .catch((reason: unknown) => {
        settleSpawn();
        composer.restoreDraft(prompt);
        showFailure(`Could not confirm the agent started: ${errorMessage(reason)}`);
      });
  });
  composer.element.addEventListener('chat-escape', close);
  element.addEventListener('pointerdown', (event) => event.stopPropagation());
  element.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
  document.addEventListener('pointerdown', (event) => {
    if (element.hidden || (event.target instanceof Node && element.contains(event.target))) return;
    close();
  });

  return {
    element,
    open: (target, left, top) => {
      if (isSpawning) return;
      if (shownTarget?.boxId !== target.boxId) close();
      shownTarget = target;
      heading.textContent = `New agent in ${target.title}`;
      element.hidden = false;
      const parentWidth = element.parentElement?.clientWidth ?? left + POPOVER_WIDTH_PX + EDGE_GAP_PX;
      const clampedLeft = Math.max(EDGE_GAP_PX, Math.min(left, parentWidth - POPOVER_WIDTH_PX - EDGE_GAP_PX));
      element.style.transform = `translate(${clampedLeft}px, ${Math.max(EDGE_GAP_PX, top)}px)`;
      composer.input.focus();
    },
    close,
  };
}
