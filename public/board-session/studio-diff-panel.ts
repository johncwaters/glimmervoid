import { el } from '../dom-helpers.ts';
import { errorMessage } from '#shared/text.ts';
import { mountPatchDiff } from '../review/diff-view.ts';
import type { ReaderFile } from '../review/review-reader-core.ts';
import { button } from '../ui/button.ts';
import { createPressable } from '../ui/pressable.ts';

type ChangedFile = Pick<ReaderFile, 'path' | 'added' | 'removed' | 'patch'>;

export interface ChangesPeek {
  element: HTMLElement;
  show(files: readonly ChangedFile[], left: number, top: number): void;
  moveTo(left: number, top: number): void;
  hide(): void;
}

export interface DiffPanel {
  element: HTMLElement;
  open(file: ChangedFile): void;
  close(): void;
}

function fileRowOf(file: ChangedFile, openFile: (file: ChangedFile) => void): HTMLElement {
  const row = el('div', 'bs-changes-row');
  const pathButton = createPressable('bs-changes-path', file.path);
  pathButton.addEventListener('click', () => openFile(file));
  const counts = el('span', 'bs-changes-counts');
  counts.append(el('span', 'bs-changes-added', `+${file.added}`), el('span', 'bs-changes-removed', `-${file.removed}`));
  row.append(pathButton, counts);
  return row;
}

export function createChangesPeek(openFile: (file: ChangedFile) => void): ChangesPeek {
  const element = el('div', 'bs-changes');
  element.hidden = true;
  const moveTo = (left: number, top: number) => {
    element.style.transform = `translate(${left}px, ${top}px)`;
  };
  return {
    element,
    show: (files, left, top) => {
      element.replaceChildren(...files.map((file) => fileRowOf(file, openFile)));
      moveTo(left, top);
      element.hidden = files.length === 0;
    },
    moveTo,
    hide: () => {
      element.hidden = true;
    },
  };
}

export function createDiffPanel(): DiffPanel {
  const element = el('aside', 'bs-diff-panel');
  element.hidden = true;
  const title = el('p', 'bs-diff-title');
  const body = el('div', 'bs-diff-body');
  const failure = el('p', 'bs-failure');
  failure.hidden = true;
  let destroyShown: (() => void) | null = null;
  let openSerial = 0;
  const close = () => {
    openSerial += 1;
    destroyShown?.();
    destroyShown = null;
    body.replaceChildren();
    element.hidden = true;
  };
  const closeButton = button({ variant: 'quiet', size: 'small', textCase: 'inline', label: 'Close', shortcutKey: 'Esc', onClick: close });
  const head = el('div', 'bs-diff-head');
  head.append(title, closeButton);
  element.append(head, failure, body);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || element.hidden) return;
    event.preventDefault();
    close();
  });
  return {
    element,
    open: (file) => {
      close();
      const serial = openSerial;
      title.textContent = file.path;
      failure.hidden = true;
      element.hidden = false;
      const host = el('div', 'bs-diff-host');
      body.append(host);
      closeButton.focus();
      mountPatchDiff(host, file.patch, 'unified')
        .then((mounted) => {
          if (serial !== openSerial) return mounted.destroy();
          destroyShown = mounted.destroy;
        })
        .catch((error: unknown) => {
          if (serial !== openSerial) return;
          failure.textContent = errorMessage(error);
          failure.hidden = false;
        });
    },
    close,
  };
}
