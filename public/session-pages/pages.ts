import { changesPage } from '../review/review-reader.ts';
import { registerSessionPage } from './session-pages.ts';

export function registerSessionPages() {
  registerSessionPage(changesPage);
}
