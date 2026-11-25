import { el } from '../dom-helpers.ts';
import { sendControlRequest } from '../control-ws.ts';
import type { StudioGuideStep } from '#shared/contracts/studio-guide.ts';

const GUIDE_TIMEOUT_MS = 10000;
const WELCOME_TITLE_TEXT = 'Your repo as a map';
const CORNER_TITLE_TEXT = 'Getting started';
const WELCOME_LEAD_TEXT = 'Each box is a part of the repo. Agents show up on the boxes they work on.';
const FAILED_TEXT = 'The map could not be drawn yet; the Orchestrator still works, and the map retries on its own.';
const STEP_TEXT_BY_STEP: Record<StudioGuideStep, string> = {
  talk: 'Tell the Orchestrator what you want below',
  branch: 'Click a box to start an agent on just that part',
  diff: 'Hover a tinted box to see what changed',
  progress: 'Ask "how is it going?" any time',
};
const GUIDE_STEPS: readonly StudioGuideStep[] = ['talk', 'branch', 'diff', 'progress'];

export type StudioMapState = 'drawn' | 'absent' | 'building' | 'failed';

export interface StudioGuide {
  element: HTMLElement;
  show(mapState: StudioMapState, repoLabel: string): void;
  markDone(step: StudioGuideStep): void;
  isShowingWelcome(): boolean;
}

function buildingTextOf(repoLabel: string): string {
  return `Drawing the map of ${repoLabel}`;
}

export function createStudioGuide(): StudioGuide {
  const element = el('aside', 'bs-guide');
  element.hidden = true;
  element.setAttribute('aria-label', CORNER_TITLE_TEXT);
  const title = el('p', 'bs-guide-title');
  const lead = el('p', 'bs-guide-lead', WELCOME_LEAD_TEXT);
  const stepList = el('ol', 'bs-guide-steps');
  const stepRowByStep = new Map(GUIDE_STEPS.map((step) => {
    const row = el('li', 'bs-guide-step');
    row.append(el('span', 'bs-guide-step-mark', String(GUIDE_STEPS.indexOf(step) + 1)), el('span', 'bs-guide-step-text', STEP_TEXT_BY_STEP[step]));
    stepList.append(row);
    return [step, row] as const;
  }));
  const mapLine = el('p', 'bs-guide-map');
  mapLine.setAttribute('role', 'status');
  element.append(title, lead, stepList, mapLine);

  let doneSteps: ReadonlySet<StudioGuideStep> | null = null;
  let shownMapState: StudioMapState = 'drawn';
  let shownRepoLabel = '';
  let hasShownDrawnMap = false;

  const isShowingWelcome = () => !hasShownDrawnMap && (shownMapState === 'building' || shownMapState === 'failed');

  const isFinished = () => doneSteps !== null && GUIDE_STEPS.every((step) => doneSteps?.has(step));

  const paint = () => {
    element.hidden = doneSteps === null || isFinished();
    if (element.hidden) return;
    const isWelcome = isShowingWelcome();
    element.dataset.place = isWelcome ? 'center' : 'corner';
    title.textContent = isWelcome ? WELCOME_TITLE_TEXT : CORNER_TITLE_TEXT;
    lead.hidden = !isWelcome;
    mapLine.hidden = !isWelcome;
    mapLine.dataset.failed = String(shownMapState === 'failed');
    mapLine.textContent = shownMapState === 'failed' ? FAILED_TEXT : buildingTextOf(shownRepoLabel);
    for (const [step, row] of stepRowByStep) row.toggleAttribute('data-done', doneSteps?.has(step) === true);
  };

  const adopt = (reply: { type: string; ok?: boolean; doneSteps?: readonly StudioGuideStep[] }) => {
    if (reply.type !== 'studio-guide-result' || reply.ok !== true) return;
    doneSteps = new Set(reply.doneSteps ?? []);
    paint();
  };

  sendControlRequest('studio-guide', { step: null }, { timeoutMs: GUIDE_TIMEOUT_MS }).then(adopt).catch(() => {});

  return {
    element,
    show: (mapState, repoLabel) => {
      shownMapState = mapState;
      shownRepoLabel = repoLabel;
      hasShownDrawnMap = hasShownDrawnMap || mapState === 'drawn';
      paint();
    },
    markDone: (step) => {
      if (doneSteps?.has(step)) return;
      sendControlRequest('studio-guide', { step }, { timeoutMs: GUIDE_TIMEOUT_MS }).then(adopt).catch(() => {});
    },
    isShowingWelcome: () => !element.hidden && isShowingWelcome(),
  };
}
