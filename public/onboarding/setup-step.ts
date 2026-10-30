import { el, writeClipboardText } from '../dom-helpers.ts';

type SetupStepState = 'done' | 'current' | 'upcoming';

const STEP_ICON_BY_STATE: Readonly<Record<SetupStepState, string>> = {
  done: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Done"><circle cx="12" cy="12" r="10"></circle><path d="M7.5 12.5l3 3 6-6.5"></path></svg>',
  current: '<svg width="18" height="18" viewBox="0 0 24 24" role="img" aria-label="Needed"><path d="M12 3l9 9-9 9-9-9z" fill="currentColor"></path></svg>',
  upcoming: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" role="img" aria-label="Not started"><circle cx="12" cy="12" r="10"></circle></svg>',
};

export function buildSetupStep({ title, state, summary, badge, body }: {
  title: string;
  state: SetupStepState;
  summary: string;
  badge: string;
  body: () => HTMLElement[];
}): HTMLLIElement {
  const step = el('li', 'first-run-step');
  step.dataset.state = state;
  if (state === 'current') step.setAttribute('aria-current', 'step');
  const head = el('div', 'first-run-step-head');
  const icon = el('span', 'first-run-step-icon');
  icon.innerHTML = STEP_ICON_BY_STATE[state];
  head.append(icon, el('span', 'first-run-step-title', title));
  if (state === 'done' && summary) head.append(el('span', 'first-run-step-summary', summary));
  if (state === 'current' && badge) head.append(el('span', 'first-run-step-badge', badge));
  step.append(head);
  if (state !== 'current') return step;
  const stepBody = el('div', 'first-run-step-body');
  stepBody.append(...body());
  step.append(stepBody);
  return step;
}

export function buildCommandRow(command: string): HTMLElement {
  const row = el('div', 'first-run-command-row');
  row.append(el('code', 'first-run-command', command));
  if (!navigator.clipboard?.writeText) return row;
  const copyButton = el('button', 'btn-dialog btn-dialog-cancel', 'Copy');
  copyButton.type = 'button';
  const copyStatus = el('span', 'first-run-copy-status');
  copyStatus.setAttribute('role', 'status');
  copyButton.addEventListener('click', async () => {
    const write = writeClipboardText(command);
    copyStatus.textContent = write ? await write.then(() => 'Copied', () => 'Copy failed') : 'Copy failed';
  });
  row.append(copyButton, copyStatus);
  return row;
}
