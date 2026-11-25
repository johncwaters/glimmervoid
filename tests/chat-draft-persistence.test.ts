import './helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { stubGlobalForTest } from './helpers/frontend-global-stub.ts';
import { chatDraftOf, forgetChatDraft, pruneChatDraftsForSessions, saveChatDraft, scheduleChatDraftSave } from '../public/chat/chat-session-state.ts';

function stubFullStorage(context: TestContext): Map<string, string> {
  const entries = new Map<string, string>();
  stubGlobalForTest(context, 'localStorage', {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  });
  return entries;
}

function stubWindowPageHide(context: TestContext): () => void {
  const listeners: (() => void)[] = [];
  stubGlobalForTest(context, 'window', {
    addEventListener: (eventName: string, listener: () => void) => {
      if (eventName === 'pagehide') listeners.push(listener);
    },
  });
  return () => {
    for (const listener of listeners) listener();
  };
}

test('chat drafts persist per session, clear on empty save, and prune only stale draft keys', (context) => {
  const storage = stubFullStorage(context);
  storage.set('glimmervoid-ui-prefs', '{"themeId":"glimmer"}');

  saveChatDraft('session-a', 'draft for a ');
  saveChatDraft('session-b', 'draft for b');
  assert.equal(chatDraftOf('session-a'), 'draft for a ');
  assert.equal(chatDraftOf('session-b'), 'draft for b');
  assert.equal(storage.get('glimmervoid-ui-prefs'), '{"themeId":"glimmer"}');

  saveChatDraft('session-a', '');
  assert.equal(chatDraftOf('session-a'), '');
  assert.equal(storage.has('glimmervoid-chat-draft:session-a'), false);

  saveChatDraft('session-c', 'stale draft');
  pruneChatDraftsForSessions(new Set(['session-b']));
  assert.equal(chatDraftOf('session-b'), 'draft for b');
  assert.equal(chatDraftOf('session-c'), '');
  assert.equal(storage.get('glimmervoid-ui-prefs'), '{"themeId":"glimmer"}');

  forgetChatDraft('session-b');
  assert.equal(chatDraftOf('session-b'), '');
  assert.equal(storage.has('glimmervoid-chat-draft:session-b'), false);
});

test('scheduled draft saves flush on pagehide and cancel when cleared before the timer fires', (context) => {
  const storage = stubFullStorage(context);
  const triggerPageHide = stubWindowPageHide(context);

  scheduleChatDraftSave('session-refresh', 'unsent text');
  assert.equal(chatDraftOf('session-refresh'), 'unsent text');
  assert.equal(storage.has('glimmervoid-chat-draft:session-refresh'), false);

  triggerPageHide();
  assert.equal(storage.get('glimmervoid-chat-draft:session-refresh'), 'unsent text');

  scheduleChatDraftSave('session-sent', 'about to send');
  saveChatDraft('session-sent', '');
  triggerPageHide();
  assert.equal(storage.has('glimmervoid-chat-draft:session-sent'), false);
});
