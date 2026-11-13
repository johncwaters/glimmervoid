import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import type { SessionUi } from './card-registry.ts';
import { copyLastOutput, copyScreen, readAllLines } from './touch-select.ts';

export function openSelectSheet(ui: SessionUi) {
  if (!ui.term) return;
  const sheet = el('div', 'terminal-select-sheet');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Select text');
  const actions = el('div', 'terminal-select-sheet-actions');
  const copyScreenButton = button({ variant: 'secondary', size: 'small', label: 'Copy screen', action: 'copy-screen' });
  const copyOutputButton = button({ variant: 'secondary', size: 'small', label: 'Copy output', action: 'copy-output' });
  const closeButton = button({ variant: 'secondary', label: 'Close', action: 'close-select' });
  copyScreenButton.addEventListener('click', () => copyScreen(ui));
  copyOutputButton.addEventListener('click', () => copyLastOutput(ui));
  closeButton.addEventListener('click', () => sheet.remove());
  actions.append(copyScreenButton, copyOutputButton);
  const footer = el('div', 'terminal-select-sheet-footer');
  footer.append(closeButton);
  const text = el('pre', 'terminal-select-sheet-text');
  text.textContent = readAllLines(ui.term).join('\n').trimEnd();
  sheet.append(actions, text, footer);
  document.body.append(sheet);
  text.scrollTop = text.scrollHeight;
}
