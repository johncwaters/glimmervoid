import type { InstallFailureKind, NoticeId, NoticeTone } from '#shared/contracts/control-messages.ts';
import { reportNoticeShown } from '../control-ws.ts';
import { el, queryTag } from '../dom-helpers.ts';
import { CLOSE_ICON_PATH, createLineIcon } from '../svg-dom.ts';
import { button } from './button.ts';
import { copyButton } from './copy-button.ts';
import { noticeDescriptor, noticeMetaState, noticeShownPayload } from './notice-core.ts';

export type { NoticeTone };

type NoticeOptions = {
  id: NoticeId;
  dismissLabel: string;
  isDismissIcon: boolean;
  onDismiss: () => void;
  leading?: HTMLElement;
};

type NoticeContent = {
  text: string | readonly (string | Node)[];
  tone?: NoticeTone;
  actions?: readonly HTMLElement[];
  command?: string;
  meta?: string;
  reported?: { source: string; kind?: InstallFailureKind };
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
  const initial = noticeDescriptor({ id, dismissLabel, isDismissIcon, shown: false, hasActions: false });
  const element = el('div', initial.className);
  element.id = initial.id;
  element.setAttribute('role', initial.role);
  element.hidden = initial.hidden;
  const textElement = el('span', initial.textClassName);
  const actionsElement = el('span', initial.actionsClassName);
  const commandElement = el('code', initial.commandClassName);
  let shownCommand = '';
  const commandCopy = copyButton({ size: 'small', action: initial.copyAction, text: () => shownCommand });
  const metaElement = el('span', initial.metaClassName);
  const dismissButton = initial.dismissVariant === 'icon'
    ? button({ variant: 'icon', size: 'small', label: initial.dismissLabel, icon: createLineIcon(CLOSE_ICON_PATH), action: initial.dismissAction })
    : button({ variant: 'secondary', size: 'small', label: initial.dismissLabel, action: initial.dismissAction });
  dismissButton.classList.add(initial.dismissClassName);
  if (leading) element.append(leading);
  element.append(textElement, actionsElement, commandElement, commandCopy.element, metaElement, dismissButton);

  dismissButton.addEventListener('click', () => {
    element.hidden = true;
    onDismiss();
  });

  const setMeta = (metaText: string) => {
    const state = noticeMetaState(metaText);
    if (metaElement.textContent !== state.text) metaElement.textContent = state.text;
    metaElement.hidden = state.hidden;
  };

  const show = ({ text, tone, actions = [], command = '', meta = '', reported }: NoticeContent) => {
    const next = noticeDescriptor({
      id,
      dismissLabel,
      isDismissIcon,
      shown: true,
      tone,
      hasActions: actions.length > 0,
      command,
      meta,
    });
    textElement.replaceChildren(...(typeof text === 'string' ? [text] : text));
    actionsElement.replaceChildren(...actions);
    actionsElement.hidden = next.actionsHidden;
    shownCommand = next.command;
    commandElement.textContent = next.command;
    commandElement.hidden = next.commandHidden;
    commandCopy.element.hidden = next.commandHidden;
    commandCopy.clearStatus();
    setMeta(next.meta);
    if (next.tone) element.dataset.tone = next.tone;
    if (!next.tone) delete element.dataset.tone;
    element.hidden = next.hidden;
    reportNoticeShown(noticeShownPayload({ id, message: textElement.textContent ?? '', tone: next.tone, reported }));
  };

  const hide = () => {
    element.hidden = true;
  };

  return { element, show, hide, setMeta, isShown: () => !element.hidden };
}
