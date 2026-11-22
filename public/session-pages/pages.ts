import { chatPage } from '../chat/chat-page.ts';
import { changesPage } from '../review/review-reader.ts';
import { previewPage } from '../preview/preview-page.ts';
import { registerSessionPage } from '../page-registry.ts';

export function registerSessionPages() {
  registerSessionPage(previewPage);
  registerSessionPage(chatPage);
  registerSessionPage(changesPage);
}
