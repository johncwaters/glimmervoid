import { changesPage } from '../review/review-reader.ts';
import { shownPage } from '../shown-files.ts';
import { registerSessionPage } from './session-pages.ts';

export function registerSessionPages() {
  registerSessionPage(changesPage);
  registerSessionPage(shownPage);
}
