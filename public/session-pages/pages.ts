import { chatPage } from '../chat/chat-page.ts';
import { changesPage } from '../review/review-reader.ts';
import { previewPage } from '../preview/preview-page.ts';
import { registerSessionPage } from './session-pages.ts';

export function registerSessionPages() {
  registerSessionPage(chatPage);
  registerSessionPage(changesPage);
  registerSessionPage(previewPage);
}
