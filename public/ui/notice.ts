import { el, queryTag, writeClipboardText } from '../dom-helpers.ts';
import { CLOSE_ICON_PATH, createLineIcon } from '../svg-dom.ts';
import { button } from './button.ts';

export type NoticeTone = 'failed' | 'warning';

type NoticeOptions = {
  id: string;
  dismissLabel: string;
  isDismissIcon: boolean;
  onDismiss: () => void;
  leading?: HTMLElement;
};

export type NoticeContent = {
  text: string | readonly (string | Node)[];
  tone?: NoticeTone;
  actions?: readonly HTMLElement[];
  command?: string;
  meta?: string;
};

export type Notice = {
  readonly element: HTMLDivElement;
  show: (content: NoticeContent) => void;
  hide: () => void;
  setMeta: (metaText: string) => void;
  isShown: () => boolean;
};

export function noticeStack(): HTMLDivElement {
  return queryTag(document, '#notice-stack', 'div');
}

export function createNotice({ id, dismissLabel, isDismissIcon, onDismiss, leading }: NoticeOptions): Notice {
  const element = el('div', 'notice');
  element.id = id;
  element.setAttribute('role', 'status');
  element.hidden = true;
  const textElement = el('span', 'notice-text');
  const actionsElement = el('span', 'notice-actions');
  const commandElement = el('code', 'notice-command');
  const copyButton = button({ variant: 'secondary', size: 'small', label: 'Copy', action: 'copy-notice-command' });
  const copyStatus = el('span', 'notice-copy-status');
  copyStatus.setAttribute('role', 'status');
  const metaElement = el('span', 'notice-meta');
  const dismissButton = isDismissIcon
    ? button({ variant: 'icon', size: 'small', label: dismissLabel, icon: createLineIcon(CLOSE_ICON_PATH), action: 'dismiss-notice' })
    : button({ variant: 'secondary', size: 'small', label: dismissLabel, action: 'dismiss-notice' });
  dismissButton.classList.add('notice-dismiss');
  if (leading) element.append(leading);
  element.append(textElement, actionsElement, commandElement, copyButton, copyStatus, metaElement, dismissButton);

  let shownCommand = '';
  copyButton.addEventListener('click', () => {
    const write = writeClipboardText(shownCommand);
    if (!write) {
      copyStatus.textContent = 'Copy failed';
      return;
    }
    write
      .then(() => { copyStatus.textContent = 'Copied'; })
      .catch(() => { copyStatus.textContent = 'Copy failed'; });
  });
  dismissButton.addEventListener('click', () => {
    element.hidden = true;
    onDismiss();
  });

  const setMeta = (metaText: string) => {
    if (metaElement.textContent !== metaText) metaElement.textContent = metaText;
    metaElement.hidden = metaText === '';
  };

  const show = ({ text, tone, actions = [], command = '', meta = '' }: NoticeContent) => {
    textElement.replaceChildren(...(typeof text === 'string' ? [text] : text));
    actionsElement.replaceChildren(...actions);
    actionsElement.hidden = actions.length === 0;
    shownCommand = command;
    commandElement.textContent = command;
    const hasCommand = command !== '';
    commandElement.hidden = !hasCommand;
    copyButton.hidden = !hasCommand;
    copyStatus.hidden = !hasCommand;
    copyStatus.textContent = '';
    setMeta(meta);
    if (tone) element.dataset.tone = tone;
    if (!tone) delete element.dataset.tone;
    element.hidden = false;
  };

  const hide = () => {
    element.hidden = true;
  };

  return { element, show, hide, setMeta, isShown: () => !element.hidden };
}
