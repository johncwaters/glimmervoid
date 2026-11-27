import type { Page } from 'playwright-core';
import type { CLIENT_MESSAGE_CLASS, CollectionName } from '#shared/contracts/control/message-classes.ts';
import type { Layout } from './cases-core.ts';
import { ACTION_CONTINUITY_STUBS, COLLECTION_CONTINUITY_STUBS } from './continuity-stubs.ts';
import type { ControlFaultController } from './continuity.ts';

type MutatingClientMessageType = {
  [Type in keyof typeof CLIENT_MESSAGE_CLASS]: (typeof CLIENT_MESSAGE_CLASS)[Type] extends 'mutating' ? Type : never;
}[keyof typeof CLIENT_MESSAGE_CLASS];

export type ActionCheckId = 'C1' | 'C2' | 'C5';
export type CollectionCheckId = 'C3' | 'C4';

export interface ContinuityCaseContext {
  page: Page;
  layout: Layout;
  sessionId: string;
  projectDirectory: string;
  faults: ControlFaultController;
}

export interface ActionCaseHandle {
  cleanup: () => Promise<void>;
}

export interface CollectionCaseHandle {
  listSelector: string;
  scrollSelector: string;
  focusSelector: string | null;
  observeRemovedNodesOnC4?: boolean;
  allowControlRequestsOnC4?: boolean;
  switchAwayAndBack: () => Promise<void>;
  verifyAfterReturn?: () => Promise<string | null>;
  cleanup: () => Promise<void>;
}

export interface ActionContinuityCase {
  name: MutatingClientMessageType;
  checks: readonly ActionCheckId[];
  stub?: boolean;
  prepare: (ctx: ContinuityCaseContext, check: ActionCheckId) => Promise<ActionCaseHandle>;
}

export interface CollectionContinuityCase {
  name: CollectionName;
  checks: readonly CollectionCheckId[];
  stub?: boolean;
  prepare: (ctx: ContinuityCaseContext, check: CollectionCheckId) => Promise<CollectionCaseHandle>;
}

const PHONE_MORE_SELECTOR = 'button.phone-nav-item[aria-expanded]';
const PHONE_BOARD_TAB_SELECTOR = 'button.phone-nav-item[data-screen="board"]';
const PHONE_BACK_SELECTOR = 'button[data-action="back-to-board"]';

const MODULE_URLS = {
  ingest: '/state/ingest.ts',
  seq: '/state/seq.ts',
  settingsCollection: '/state/collections/settings.ts',
  studioCollection: '/state/collections/studio.ts',
  chatOutboxCollection: '/state/collections/chat-outbox.ts',
  packsCollection: '/state/collections/packs.ts',
  settingsBridge: '/settings/settings-panel-bridge.ts',
  addRepoRoots: '/state/actions/add-repo-roots.ts',
  addSession: '/state/actions/add-session.ts',
  chatCancel: '/state/actions/chat-cancel.ts',
  chatSend: '/state/actions/chat-send.ts',
  codemapFolderSet: '/state/actions/codemap-folder-set.ts',
  deleteHook: '/state/actions/delete-hook.ts',
  packApprove: '/state/actions/pack-approve.ts',
  packFolderRemove: '/state/actions/pack-folder-remove.ts',
  packSourceEnable: '/state/actions/pack-source-enable.ts',
  packSourceRemove: '/state/actions/pack-source-remove.ts',
  removeSession: '/state/actions/remove-session.ts',
  renameSession: '/state/actions/rename-session.ts',
  restart: '/state/actions/restart.ts',
  saveHook: '/state/actions/save-hook.ts',
  studioMainEnsure: '/state/actions/studio-main-ensure.ts',
  updateApply: '/state/actions/update-apply.ts',
  updateCheck: '/state/actions/update-check.ts',
  updateSettings: '/state/actions/update-settings.ts',
} as const;

async function preloadModules(page: Page, urls: readonly string[]): Promise<void> {
  await page.evaluate(async (moduleUrls) => {
    const existingCache = Reflect.get(window, '__continuityModules') as Record<string, unknown> | undefined;
    const cache = existingCache ?? {};
    Reflect.set(window, '__continuityModules', cache);
    for (const url of moduleUrls) {
      if (cache[url]) continue;
      cache[url] = await import(url);
    }
  }, [...urls]);
}

async function readActiveActionValue(page: Page): Promise<string> {
  return page.evaluate(() => {
    const action = Reflect.get(window, '__continuityActiveAction') as { readValue: () => string } | undefined;
    return action ? action.readValue() : '';
  });
}

async function openFocusBoard(page: Page, layout: Layout): Promise<void> {
  if (layout === 'phone') {
    const backButton = page.locator(PHONE_BACK_SELECTOR).first();
    if (await backButton.isVisible()) {
      await backButton.click();
      return;
    }
    const boardNav = page.locator(PHONE_BOARD_TAB_SELECTOR).first();
    if (await boardNav.isVisible()) {
      await boardNav.click();
    }
    return;
  }
  const focusTab = page.locator('#tab-focus').first();
  if (await focusTab.isVisible()) await focusTab.click();
}

async function openSettingsSection(page: Page, layout: Layout, sectionName: string | null): Promise<void> {
  if (layout === 'phone') {
    const moreButton = page.locator(PHONE_MORE_SELECTOR).first();
    await moreButton.waitFor({ state: 'visible', timeout: 5000 });
    await moreButton.click();
    const settingsItem = page.locator('button.phone-nav-menu-item[data-screen="settings"]').first();
    await settingsItem.waitFor({ state: 'visible', timeout: 5000 });
    await settingsItem.click();
    if (sectionName === null) return;
    if (sectionName === 'Hooks' && await page.locator('.hooks-panel').isVisible()) return;
    const settingsBack = page.locator('button[data-action="back-to-settings-list"]').first();
    if (await settingsBack.isVisible()) await settingsBack.click();
  }
  if (layout !== 'phone') {
    const settingsTab = page.locator('#tab-settings').first();
    await settingsTab.waitFor({ state: 'visible', timeout: 5000 });
    await settingsTab.click();
  }
  if (sectionName === null) return;
  const navItem = page.locator('button.settings-view-nav-item', { hasText: new RegExp(`^${sectionName}$`) }).first();
  await navItem.waitFor({ state: 'visible', timeout: 5000 });
  await navItem.click();
}

async function openPacksScreen(page: Page, layout: Layout): Promise<void> {
  if (layout === 'phone') {
    const moreButton = page.locator(PHONE_MORE_SELECTOR).first();
    await moreButton.waitFor({ state: 'visible', timeout: 5000 });
    await moreButton.click();
    const packsItem = page.locator('button.phone-nav-menu-item[data-screen="packs"]').first();
    await packsItem.waitFor({ state: 'visible', timeout: 5000 });
    await packsItem.click();
  }
  if (layout !== 'phone') {
    const packsTab = page.locator('#tab-packs').first();
    await packsTab.waitFor({ state: 'visible', timeout: 5000 });
    await packsTab.click();
  }
  await page.locator('.packs-body').waitFor({ state: 'visible', timeout: 5000 });
}

async function openStudioScreen(page: Page, layout: Layout): Promise<void> {
  if (layout === 'phone') {
    const moreButton = page.locator(PHONE_MORE_SELECTOR).first();
    if (await moreButton.isVisible()) {
      await moreButton.click();
      const studioItem = page.locator('button.phone-nav-menu-item[data-screen="board-session"]').first();
      if (await studioItem.isVisible()) {
        await studioItem.click();
        return;
      }
      await moreButton.click();
    }
    return;
  }
  const studioTab = page.locator('#tab-board-session').first();
  if (await studioTab.isVisible()) await studioTab.click();
}

function rosterRowSelector(layout: Layout, sessionId: string): string {
  if (layout === 'phone') return `.phone-board-list button.session-row[data-id="${sessionId}"]`;
  return `.focus-rail button.session-row[data-id="${sessionId}"]`;
}

function buildPacksStatusPayload(overrides: {
  pendingState?: 'pending' | 'approved';
  includePending?: boolean;
  includeSourcePack?: boolean;
  includeSource?: boolean;
} = {}): Record<string, unknown> {
  const pendingState = overrides.pendingState ?? 'pending';
  const includePending = overrides.includePending ?? true;
  const includeSourcePack = overrides.includeSourcePack ?? true;
  const includeSource = overrides.includeSource ?? true;
  const packs: Record<string, unknown>[] = [];
  if (includePending) {
    packs.push({
      name: 'continuity-pending-pack',
      version: 1,
      description: 'Pending pack for continuity check',
      dir: '/tmp/continuity-pending-pack',
      state: pendingState,
      fingerprint: 'fp-continuity-pending',
      files: ['pack.json'],
      needs: [],
      missingRequires: [],
      prFlows: null,
      themes: [],
      previewDataUrl: null,
      panels: [],
      launchers: [],
      sessions: null,
      statusUrls: [],
      agent: null,
      mcpServers: [],
      hooks: [],
      settings: [],
      jobs: [],
      community: null,
      errors: [],
      isPlacedByHand: true,
    });
  }
  if (includeSourcePack) {
    packs.push({
      name: 'continuity-source-pack',
      version: 1,
      description: 'Source pack for continuity check',
      dir: '/tmp/continuity-source-pack',
      state: 'approved',
      fingerprint: 'fp-continuity-source',
      files: ['pack.json'],
      needs: [],
      missingRequires: [],
      prFlows: null,
      themes: [],
      previewDataUrl: null,
      panels: [],
      launchers: [],
      sessions: null,
      statusUrls: [],
      agent: null,
      mcpServers: [],
      hooks: [],
      settings: [],
      jobs: [],
      community: null,
      errors: [],
      isPlacedByHand: false,
    });
  }
  const sources = includeSource
    ? [
      {
        url: 'https://github.com/example/continuity-packs',
        slug: 'continuity-source-slug',
        dir: '/tmp/continuity-source',
        isBuiltIn: false,
        packs: [
          {
            name: 'continuity-source-pack',
            dir: '/tmp/continuity-source/continuity-source-pack',
            isEnabled: includeSourcePack,
            version: 1,
            description: 'Source pack for continuity check',
            kinds: ['Panel'],
            iconDataUrl: null,
            themeSwatches: [],
            previewDataUrl: null,
          },
        ],
        error: null,
      },
    ]
    : [];
  return {
    type: 'packs-status',
    packs,
    sources,
    themes: [],
    panels: [],
    launchers: [],
    providers: [],
    warnings: [],
  };
}

async function seedPacksFixture(page: Page): Promise<void> {
  await preloadModules(page, [MODULE_URLS.ingest, MODULE_URLS.seq]);
  const payload = buildPacksStatusPayload();
  await page.evaluate(({ ingestUrl, seqUrl, statusPayload }) => {
    const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
    const ingestControlMessage = cache[ingestUrl].ingestControlMessage as (msg: Record<string, unknown>) => string;
    const currentSeq = cache[seqUrl].currentSeq as () => number;
    ingestControlMessage({ ...statusPayload, seq: currentSeq() + 1 });
  }, { ingestUrl: MODULE_URLS.ingest, seqUrl: MODULE_URLS.seq, statusPayload: payload });
}

async function seedStudioAreaFixture(page: Page, sessionId: string, repoDir: string): Promise<void> {
  await preloadModules(page, [MODULE_URLS.studioCollection]);
  await page.evaluate(({ studioUrl, targetSessionId, targetRepoDir }) => {
    const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
    const applyStudioReply = cache[studioUrl].applyStudioReply as (msg: Record<string, unknown>) => void;
    applyStudioReply({
      type: 'studio-main-ensure-result',
      requestId: 'continuity-seed-main',
      ok: true,
      mainId: targetSessionId,
      appliedSeq: 0,
    });
    applyStudioReply({
      type: 'codemap-boxes-of-response',
      requestId: 'continuity-seed-boxes',
      id: targetSessionId,
      ok: true,
      boardId: 'continuity-board-1',
      areas: [
        {
          repoKey: 'continuity-repo',
          repoName: 'continuity-repo',
          repoDir: targetRepoDir,
          anchorBoxId: 'area-box-1',
          isFolded: false,
          branchAgentId: 'claude-code',
        },
      ],
      boxesBySessionId: {},
      boxRectById: {},
      boxChoices: [],
    });
  }, { studioUrl: MODULE_URLS.studioCollection, targetSessionId: sessionId, targetRepoDir: repoDir });
}

export const ACTION_CONTINUITY_CASES: readonly ActionContinuityCase[] = [
  {
    name: 'add-repo-roots',
    checks: ['C1', 'C2', 'C5'],
    async prepare(ctx) {
      const { page, projectDirectory } = ctx;
      await preloadModules(page, [MODULE_URLS.settingsCollection, MODULE_URLS.addRepoRoots, MODULE_URLS.updateSettings]);
      const addedRoot = projectDirectory;
      await page.evaluate(async ({ settingsUrl, updateUrl, actionUrl, rootPath }) => {
        const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
        const snapshot = cache[settingsUrl].settingsPayloadSnapshot as () => { repoRoots?: string[] };
        const updateSettings = cache[updateUrl].default as (input: { settings: Record<string, unknown> }) => Promise<unknown>;
        const current = snapshot().repoRoots ?? [];
        const filtered = current.filter((entry) => entry !== rootPath);
        if (filtered.length !== current.length) await updateSettings({ settings: { repoRoots: filtered } });
        const readRoots = (): string => JSON.stringify(snapshot().repoRoots ?? []);
        Reflect.set(window, '__continuityActiveAction', {
          readValue: readRoots,
          isOptimisticShown: () => readRoots().includes(rootPath),
          fire: () => {
            const runAction = cache[actionUrl].default as (input: { roots: string[] }) => Promise<unknown>;
            Reflect.set(window, '__continuityActionPromise', runAction({ roots: [rootPath] }));
          },
        });
      }, { settingsUrl: MODULE_URLS.settingsCollection, updateUrl: MODULE_URLS.updateSettings, actionUrl: MODULE_URLS.addRepoRoots, rootPath: addedRoot });
      return {
        cleanup: async () => {
          await page.evaluate(async ({ settingsUrl, updateUrl, rootPath }) => {
            const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
            const snapshot = cache[settingsUrl].settingsPayloadSnapshot as () => { repoRoots?: string[] };
            const updateSettings = cache[updateUrl].default as (input: { settings: Record<string, unknown> }) => Promise<unknown>;
            const current = snapshot().repoRoots ?? [];
            const filtered = current.filter((entry) => entry !== rootPath);
            if (filtered.length !== current.length) await updateSettings({ settings: { repoRoots: filtered } });
          }, { settingsUrl: MODULE_URLS.settingsCollection, updateUrl: MODULE_URLS.updateSettings, rootPath: addedRoot });
        },
      };
    },
  },
  {
    name: 'add-session',
    checks: ['C1', 'C2', 'C5'],
    async prepare(ctx, check) {
      const { page, sessionId, projectDirectory, faults } = ctx;
      await preloadModules(page, [MODULE_URLS.studioCollection, MODULE_URLS.addSession]);
      await seedStudioAreaFixture(page, sessionId, projectDirectory);
      const nextAgent = 'codex';
      if (check === 'C1' || check === 'C5') {
        faults.stubRequestReply('add-session', (_frame, nextSeq) => ({
          reply: { type: 'add-session-result', ok: true, sessionId, appliedSeq: nextSeq },
          push: { type: 'session-renamed', id: sessionId, oldName: 'continuity', newName: 'continuity-studio' },
        }));
      }
      await page.evaluate(({ studioUrl, actionUrl, targetPath, targetAgent }) => {
        const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
        const studio = cache[studioUrl].default as { state: { areas: Array<{ branchAgentId?: string | null }> } };
        const readAgent = (): string => studio.state.areas[0]?.branchAgentId ?? '';
        Reflect.set(window, '__continuityActiveAction', {
          readValue: readAgent,
          isOptimisticShown: () => readAgent() === targetAgent,
          fire: () => {
            const runAction = cache[actionUrl].runStudioAddSession as (input: { name: string; path: string; agent: string }) => Promise<unknown>;
            Reflect.set(window, '__continuityActionPromise', runAction({
              name: `continuity-branch-${Date.now()}`,
              path: targetPath,
              agent: targetAgent,
            }));
          },
        });
      }, { studioUrl: MODULE_URLS.studioCollection, actionUrl: MODULE_URLS.addSession, targetPath: projectDirectory, targetAgent: nextAgent });
      return {
        cleanup: async () => {
          await seedStudioAreaFixture(page, sessionId, projectDirectory);
        },
      };
    },
  },
  {
    name: 'chat-cancel',
    checks: ['C1', 'C2', 'C5'],
    async prepare(ctx, check) {
      const { page, sessionId, faults } = ctx;
      await preloadModules(page, [MODULE_URLS.ingest, MODULE_URLS.seq, MODULE_URLS.chatOutboxCollection, MODULE_URLS.chatCancel]);
      const entryId = `continuity-held-${Date.now()}`;
      if (check === 'C5') {
        faults.stubRequestReply('chat-cancel', (_frame, nextSeq) => ({
          reply: { type: 'chat-cancel-result', id: sessionId, entryId, cancelledTexts: ['held message for cancel check'], appliedSeq: nextSeq },
          push: { type: 'session-status', id: sessionId, session: 'continuity', timestamp: Date.now(), chatOutbox: [] },
        }));
      }
      await page.evaluate(({ ingestUrl, seqUrl, outboxUrl, actionUrl, targetSessionId, targetEntryId }) => {
        const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
        const ingestControlMessage = cache[ingestUrl].ingestControlMessage as (msg: Record<string, unknown>) => string;
        const currentSeq = cache[seqUrl].currentSeq as () => number;
        ingestControlMessage({
          type: 'session-status',
          seq: currentSeq() + 1,
          id: targetSessionId,
          session: 'continuity',
          timestamp: Date.now(),
          chatOutbox: [
            {
              entryId: targetEntryId,
              text: 'held message for cancel check',
              attachments: [],
              state: 'held',
              failure: null,
              shouldOpenTerminal: false,
              origin: 'operator',
            },
          ],
        });
        const entriesOf = cache[outboxUrl].chatOutboxEntriesOf as (id: string) => ReadonlyArray<{ entryId: string }>;
        const readCount = (): string => (entriesOf(targetSessionId).some((entry) => entry.entryId === targetEntryId) ? 'present' : 'removed');
        Reflect.set(window, '__continuityActiveAction', {
          readValue: readCount,
          isOptimisticShown: () => readCount() === 'removed',
          fire: () => {
            const runAction = cache[actionUrl].default as (input: { id: string; entryId: string }) => Promise<unknown>;
            Reflect.set(window, '__continuityActionPromise', runAction({ id: targetSessionId, entryId: targetEntryId }));
          },
        });
      }, { ingestUrl: MODULE_URLS.ingest, seqUrl: MODULE_URLS.seq, outboxUrl: MODULE_URLS.chatOutboxCollection, actionUrl: MODULE_URLS.chatCancel, targetSessionId: sessionId, targetEntryId: entryId });
      return {
        cleanup: async () => {
          await page.evaluate(({ ingestUrl, seqUrl, targetSessionId }) => {
            const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
            const ingestControlMessage = cache[ingestUrl].ingestControlMessage as (msg: Record<string, unknown>) => string;
            const currentSeq = cache[seqUrl].currentSeq as () => number;
            ingestControlMessage({
              type: 'session-status',
              seq: currentSeq() + 1,
              id: targetSessionId,
              session: 'continuity',
              timestamp: Date.now(),
              chatOutbox: [],
            });
          }, { ingestUrl: MODULE_URLS.ingest, seqUrl: MODULE_URLS.seq, targetSessionId: sessionId });
        },
      };
    },
  },
  {
    name: 'chat-send',
    checks: ['C1', 'C2', 'C5'],
    async prepare(ctx, check) {
      const { page, sessionId, faults } = ctx;
      await preloadModules(page, [MODULE_URLS.ingest, MODULE_URLS.seq, MODULE_URLS.chatOutboxCollection, MODULE_URLS.chatSend]);
      const probeText = `continuity chat probe ${Date.now()}`;
      if (check === 'C5') {
        faults.stubRequestReply('chat-send', (_frame, nextSeq) => ({
          reply: { type: 'chat-send-result', id: sessionId, ok: true, acceptedAt: Date.now(), appliedSeq: nextSeq },
          push: {
            type: 'session-status',
            id: sessionId,
            session: 'continuity',
            timestamp: Date.now(),
            chatOutbox: [
              {
                entryId: `server-outbox-${nextSeq}`,
                text: probeText,
                attachments: [],
                state: 'held',
                failure: null,
                shouldOpenTerminal: false,
                origin: 'operator',
              },
            ],
          },
        }));
      }
      await page.evaluate(({ outboxUrl, actionUrl, targetSessionId, expectedText }) => {
        const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
        const entriesOf = cache[outboxUrl].chatOutboxEntriesOf as (id: string) => ReadonlyArray<{ text: string }>;
        const readHasPrompt = (): string => (entriesOf(targetSessionId).some((entry) => entry.text === expectedText) ? 'shown' : 'absent');
        Reflect.set(window, '__continuityActiveAction', {
          readValue: readHasPrompt,
          isOptimisticShown: () => readHasPrompt() === 'shown',
          fire: () => {
            const runAction = cache[actionUrl].default as (input: { id: string; text: string; attachments: string[]; isTurnRunning: boolean }) => Promise<unknown>;
            Reflect.set(window, '__continuityActionPromise', runAction({
              id: targetSessionId,
              text: expectedText,
              attachments: [],
              isTurnRunning: true,
            }));
          },
        });
      }, { outboxUrl: MODULE_URLS.chatOutboxCollection, actionUrl: MODULE_URLS.chatSend, targetSessionId: sessionId, expectedText: probeText });
      return {
        cleanup: async () => {
          await page.evaluate(({ ingestUrl, seqUrl, targetSessionId }) => {
            const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
            const ingestControlMessage = cache[ingestUrl].ingestControlMessage as (msg: Record<string, unknown>) => string;
            const currentSeq = cache[seqUrl].currentSeq as () => number;
            ingestControlMessage({
              type: 'session-status',
              seq: currentSeq() + 1,
              id: targetSessionId,
              session: 'continuity',
              timestamp: Date.now(),
              chatOutbox: [],
            });
          }, { ingestUrl: MODULE_URLS.ingest, seqUrl: MODULE_URLS.seq, targetSessionId: sessionId });
        },
      };
    },
  },
  {
    name: 'codemap-folder-set',
    checks: ['C1', 'C2', 'C5'],
    async prepare(ctx, check) {
      const { page, sessionId, projectDirectory, faults } = ctx;
      await preloadModules(page, [MODULE_URLS.studioCollection, MODULE_URLS.codemapFolderSet]);
      await seedStudioAreaFixture(page, sessionId, projectDirectory);
      if (check === 'C1' || check === 'C5') {
        faults.stubRequestReply('codemap-folder-set', (_frame, nextSeq) => ({
          reply: { type: 'codemap-folder-set-result', id: sessionId, ok: true, isOpen: false, appliedSeq: nextSeq },
          push: { type: 'director-digest-kept', id: sessionId },
        }));
      }
      await page.evaluate(({ studioUrl, actionUrl, targetSessionId }) => {
        const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
        const studio = cache[studioUrl].default as { state: { areas: Array<{ isFolded: boolean }> } };
        const readFolded = (): string => String(studio.state.areas[0]?.isFolded ?? false);
        Reflect.set(window, '__continuityActiveAction', {
          readValue: readFolded,
          isOptimisticShown: () => readFolded() === 'true',
          fire: () => {
            const runAction = cache[actionUrl].runCodemapFolderSet as (input: { id: string; boxId: string; isOpen: boolean }) => Promise<unknown>;
            Reflect.set(window, '__continuityActionPromise', runAction({
              id: targetSessionId,
              boxId: 'area-box-1',
              isOpen: false,
            }));
          },
        });
      }, { studioUrl: MODULE_URLS.studioCollection, actionUrl: MODULE_URLS.codemapFolderSet, targetSessionId: sessionId });
      return {
        cleanup: async () => {
          await seedStudioAreaFixture(page, sessionId, projectDirectory);
        },
      };
    },
  },
  {
    name: 'delete-hook',
    checks: ['C1', 'C2', 'C5'],
    async prepare(ctx) {
      const { page, layout } = ctx;
      await openSettingsSection(page, layout, 'Hooks');
      await preloadModules(page, [MODULE_URLS.saveHook, MODULE_URLS.deleteHook]);
      const hookName = `Continuity delete hook ${Date.now()}`;
      const hookId = await page.evaluate(async ({ saveUrl, deleteUrl, name }) => {
        const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
        const saveHook = cache[saveUrl].default as (input: { hook: Record<string, unknown> }) => Promise<{ ok: boolean; reply?: { hook?: { id?: string } } }>;
        const saveOutcome = await saveHook({
          hook: { name, event: 'PostToolUse', type: 'command', command: 'echo ok', enabled: true },
        });
        const id = saveOutcome.reply?.hook?.id ?? '';
        const readPresent = (): string => (document.querySelector(`article.hooks-row[aria-label="${name}"]`) !== null ? 'present' : 'deleted');
        Reflect.set(window, '__continuityActiveAction', {
          readValue: readPresent,
          isOptimisticShown: () => readPresent() === 'deleted',
          fire: () => {
            const deleteHook = cache[deleteUrl].default as (input: { id: string; name: string }) => Promise<unknown>;
            Reflect.set(window, '__continuityActionPromise', deleteHook({ id, name }));
          },
        });
        return id;
      }, { saveUrl: MODULE_URLS.saveHook, deleteUrl: MODULE_URLS.deleteHook, name: hookName });
      return {
        cleanup: async () => {
          if (!hookId) return;
          const stillExists = (await readActiveActionValue(page)) === 'present';
          if (!stillExists) return;
          await page.evaluate(async ({ deleteUrl, id, name }) => {
            const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
            const deleteHook = cache[deleteUrl].default as (input: { id: string; name: string }) => Promise<unknown>;
            await deleteHook({ id, name });
          }, { deleteUrl: MODULE_URLS.deleteHook, id: hookId, name: hookName });
        },
      };
    },
  },
  {
    name: 'pack-approve',
    checks: ['C1', 'C2', 'C5'],
    async prepare(ctx, check) {
      const { page, layout, faults } = ctx;
      await openPacksScreen(page, layout);
      await preloadModules(page, [MODULE_URLS.packApprove]);
      await seedPacksFixture(page);
      if (check === 'C1' || check === 'C5') {
        faults.stubRequestReply('pack-approve', (_frame, nextSeq) => ({
          reply: { type: 'pack-approve-result', ok: true, appliedSeq: nextSeq },
          push: buildPacksStatusPayload({ pendingState: 'approved' }),
        }));
      }
      await page.evaluate((actionUrl) => {
        const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
        const readState = (): string => {
          const cards = document.querySelectorAll<HTMLElement>('.packs-card[data-pack-state]');
          for (const card of cards) {
            if (card.querySelector('.packs-card-name')?.textContent?.startsWith('continuity-pending-pack')) {
              return card.dataset.packState ?? '';
            }
          }
          return 'missing';
        };
        Reflect.set(window, '__continuityActiveAction', {
          readValue: readState,
          isOptimisticShown: () => readState() === 'approved',
          fire: () => {
            const runAction = cache[actionUrl].default as (input: { fingerprint: string; packName: string }) => Promise<unknown>;
            Reflect.set(window, '__continuityActionPromise', runAction({ fingerprint: 'fp-continuity-pending', packName: 'continuity-pending-pack' }));
          },
        });
      }, MODULE_URLS.packApprove);
      return {
        cleanup: async () => {
          await seedPacksFixture(page);
        },
      };
    },
  },
  {
    name: 'pack-folder-remove',
    checks: ['C1', 'C2', 'C5'],
    async prepare(ctx, check) {
      const { page, layout, faults } = ctx;
      await openPacksScreen(page, layout);
      await preloadModules(page, [MODULE_URLS.packFolderRemove]);
      await seedPacksFixture(page);
      if (check === 'C1' || check === 'C5') {
        faults.stubRequestReply('pack-folder-remove', (_frame, nextSeq) => ({
          reply: { type: 'pack-source-result', ok: true, appliedSeq: nextSeq },
          push: buildPacksStatusPayload({ includePending: false }),
        }));
      }
      await page.evaluate((actionUrl) => {
        const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
        const readState = (): string => {
          const cards = document.querySelectorAll<HTMLElement>('.packs-card[data-pack-state]');
          for (const card of cards) {
            if (card.querySelector('.packs-card-name')?.textContent?.startsWith('continuity-pending-pack')) {
              return 'present';
            }
          }
          return 'removed';
        };
        Reflect.set(window, '__continuityActiveAction', {
          readValue: readState,
          isOptimisticShown: () => readState() === 'removed',
          fire: () => {
            const runAction = cache[actionUrl].default as (input: { dir: string; packName: string }) => Promise<unknown>;
            Reflect.set(window, '__continuityActionPromise', runAction({ dir: '/tmp/continuity-pending-pack', packName: 'continuity-pending-pack' }));
          },
        });
      }, MODULE_URLS.packFolderRemove);
      return {
        cleanup: async () => {
          await seedPacksFixture(page);
        },
      };
    },
  },
  {
    name: 'pack-source-enable',
    checks: ['C1', 'C2', 'C5'],
    async prepare(ctx, check) {
      const { page, layout, faults } = ctx;
      await openPacksScreen(page, layout);
      await preloadModules(page, [MODULE_URLS.packSourceEnable]);
      await seedPacksFixture(page);
      if (check === 'C1' || check === 'C5') {
        faults.stubRequestReply('pack-source-enable', (_frame, nextSeq) => ({
          reply: { type: 'pack-source-result', ok: true, appliedSeq: nextSeq },
          push: buildPacksStatusPayload({ includeSourcePack: false }),
        }));
      }
      await page.evaluate((actionUrl) => {
        const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
        const readState = (): string => {
          const cards = document.querySelectorAll<HTMLElement>('.packs-card[data-pack-state]');
          for (const card of cards) {
            if (card.querySelector('.packs-card-name')?.textContent?.startsWith('continuity-source-pack')) {
              return 'present';
            }
          }
          return 'removed';
        };
        Reflect.set(window, '__continuityActiveAction', {
          readValue: readState,
          isOptimisticShown: () => readState() === 'removed',
          fire: () => {
            const runAction = cache[actionUrl].default as (input: { slug: string; pack: string; isEnabled: boolean }) => Promise<unknown>;
            Reflect.set(window, '__continuityActionPromise', runAction({ slug: 'continuity-source-slug', pack: 'continuity-source-pack', isEnabled: false }));
          },
        });
      }, MODULE_URLS.packSourceEnable);
      return {
        cleanup: async () => {
          await seedPacksFixture(page);
        },
      };
    },
  },
  {
    name: 'pack-source-remove',
    checks: ['C1', 'C2', 'C5'],
    async prepare(ctx, check) {
      const { page, layout, faults } = ctx;
      await openPacksScreen(page, layout);
      await preloadModules(page, [MODULE_URLS.packSourceRemove]);
      await seedPacksFixture(page);
      if (check === 'C1' || check === 'C5') {
        faults.stubRequestReply('pack-source-remove', (_frame, nextSeq) => ({
          reply: { type: 'pack-source-result', ok: true, appliedSeq: nextSeq },
          push: buildPacksStatusPayload({ includeSourcePack: false, includeSource: false }),
        }));
      }
      await page.evaluate((actionUrl) => {
        const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
        const readState = (): string => {
          const cards = document.querySelectorAll<HTMLElement>('.packs-card[data-pack-state]');
          for (const card of cards) {
            if (card.querySelector('.packs-card-name')?.textContent?.startsWith('continuity-source-pack')) {
              return 'present';
            }
          }
          return 'removed';
        };
        Reflect.set(window, '__continuityActiveAction', {
          readValue: readState,
          isOptimisticShown: () => readState() === 'removed',
          fire: () => {
            const runAction = cache[actionUrl].default as (input: { slug: string }) => Promise<unknown>;
            Reflect.set(window, '__continuityActionPromise', runAction({ slug: 'continuity-source-slug' }));
          },
        });
      }, MODULE_URLS.packSourceRemove);
      return {
        cleanup: async () => {
          await seedPacksFixture(page);
        },
      };
    },
  },
  {
    name: 'remove-session',
    checks: ['C1', 'C2', 'C5'],
    async prepare(ctx) {
      const { page, layout, projectDirectory } = ctx;
      await openFocusBoard(page, layout);
      await preloadModules(page, [MODULE_URLS.addSession, MODULE_URLS.removeSession]);
      const createdSessionId = await page.evaluate(async ({ addUrl, dir }) => {
        const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
        const addSession = cache[addUrl].default as (input: { name: string; path: string }) => Promise<{ ok: boolean; reply?: { sessionId?: string } }>;
        const addOutcome = await addSession({ name: `continuity-remove-${Date.now()}`, path: dir });
        return addOutcome.reply?.sessionId ?? '';
      }, { addUrl: MODULE_URLS.addSession, dir: projectDirectory });
      const rowSel = rosterRowSelector(layout, createdSessionId);
      await page.locator(rowSel).first().waitFor({ state: 'attached', timeout: 5000 });
      await page.evaluate(({ removeUrl, selector, id }) => {
        const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
        const readPresent = (): string => (document.querySelector(selector) !== null ? 'present' : 'removed');
        Reflect.set(window, '__continuityActiveAction', {
          readValue: readPresent,
          isOptimisticShown: () => readPresent() === 'removed',
          fire: () => {
            const removeSession = cache[removeUrl].default as (input: { id: string; label: string }) => Promise<unknown>;
            Reflect.set(window, '__continuityActionPromise', removeSession({ id, label: 'continuity-remove' }));
          },
        });
      }, { removeUrl: MODULE_URLS.removeSession, selector: rowSel, id: createdSessionId });
      return {
        cleanup: async () => {
          if (!createdSessionId) return;
          if ((await readActiveActionValue(page)) !== 'present') return;
          await page.evaluate(async ({ removeUrl, id }) => {
            const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
            const removeSession = cache[removeUrl].default as (input: { id: string; discardWork: boolean }) => Promise<unknown>;
            await removeSession({ id, discardWork: true });
          }, { removeUrl: MODULE_URLS.removeSession, id: createdSessionId });
        },
      };
    },
  },
  {
    name: 'rename-session',
    checks: ['C1', 'C2', 'C5'],
    async prepare(ctx) {
      const { page, layout, sessionId } = ctx;
      await openFocusBoard(page, layout);
      await preloadModules(page, [MODULE_URLS.renameSession]);
      const rowNameSelector = `${rosterRowSelector(layout, sessionId)} .session-row-name`;
      const originalName = (await page.locator(rowNameSelector).first().textContent())?.trim() ?? '';
      const targetName = `continuity-renamed-${Date.now()}`;
      await page.evaluate(({ renameUrl, selector, id, newName }) => {
        const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
        const readName = (): string => document.querySelector(selector)?.textContent?.trim() ?? '';
        Reflect.set(window, '__continuityActiveAction', {
          readValue: readName,
          isOptimisticShown: () => readName() === newName,
          fire: () => {
            const renameSession = cache[renameUrl].default as (input: { id: string; newName: string }) => Promise<unknown>;
            Reflect.set(window, '__continuityActionPromise', renameSession({ id, newName }));
          },
        });
      }, { renameUrl: MODULE_URLS.renameSession, selector: rowNameSelector, id: sessionId, newName: targetName });
      return {
        cleanup: async () => {
          if (!originalName) return;
          if ((await readActiveActionValue(page)) === originalName) return;
          await page.evaluate(async ({ renameUrl, id, newName }) => {
            const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
            const renameSession = cache[renameUrl].default as (input: { id: string; newName: string }) => Promise<unknown>;
            await renameSession({ id, newName });
          }, { renameUrl: MODULE_URLS.renameSession, id: sessionId, newName: originalName });
        },
      };
    },
  },
  {
    name: 'restart',
    checks: ['C1', 'C2', 'C5'],
    async prepare(ctx, check) {
      const { page, layout, sessionId, faults } = ctx;
      await openFocusBoard(page, layout);
      await preloadModules(page, [MODULE_URLS.restart]);
      if (check === 'C5') {
        faults.stubRequestReply('restart', (_frame, nextSeq) => ({
          reply: { type: 'session-action-result', id: sessionId, action: 'restart', ok: true, appliedSeq: nextSeq },
          push: {
            type: 'session-status',
            id: sessionId,
            session: 'continuity',
            timestamp: Date.now(),
            transition: { from: 'IDLE', to: 'INITIALIZING', event: 'restart' },
          },
        }));
      }
      const rowSelector = rosterRowSelector(layout, sessionId);
      await page.evaluate(({ restartUrl, selector, id }) => {
        const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
        const readState = (): string => document.querySelector<HTMLElement>(selector)?.dataset.state ?? '';
        Reflect.set(window, '__continuityActiveAction', {
          readValue: readState,
          isOptimisticShown: () => readState() === 'INITIALIZING',
          fire: () => {
            const restartSession = cache[restartUrl].default as (input: { id: string }) => Promise<unknown>;
            Reflect.set(window, '__continuityActionPromise', restartSession({ id }));
          },
        });
      }, { restartUrl: MODULE_URLS.restart, selector: rowSelector, id: sessionId });
      return {
        cleanup: async () => {},
      };
    },
  },
  {
    name: 'save-hook',
    checks: ['C1', 'C2', 'C5'],
    async prepare(ctx) {
      const { page, layout } = ctx;
      await openSettingsSection(page, layout, 'Hooks');
      await preloadModules(page, [MODULE_URLS.saveHook, MODULE_URLS.deleteHook]);
      const hookName = `Continuity save hook ${Date.now()}`;
      await page.evaluate(({ saveUrl, name }) => {
        const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
        const readPresent = (): string => (document.querySelector(`article.hooks-row[aria-label="${name}"]`) !== null ? 'shown' : 'absent');
        Reflect.set(window, '__continuityActiveAction', {
          readValue: readPresent,
          isOptimisticShown: () => readPresent() === 'shown',
          fire: () => {
            const saveHook = cache[saveUrl].default as (input: { hook: Record<string, unknown> }) => Promise<{ ok: boolean; reply?: { hook?: { id?: string } } }>;
            Reflect.set(window, '__continuitySavedHookId', '');
            Reflect.set(window, '__continuityActionPromise', saveHook({
              hook: { name, event: 'PostToolUse', type: 'command', command: 'echo ok', enabled: true },
            }).then((saveOutcome) => {
              Reflect.set(window, '__continuitySavedHookId', saveOutcome.reply?.hook?.id ?? '');
              return saveOutcome;
            }));
          },
        });
      }, { saveUrl: MODULE_URLS.saveHook, name: hookName });
      return {
        cleanup: async () => {
          await page.evaluate(async ({ deleteUrl, name }) => {
            const savedId = Reflect.get(window, '__continuitySavedHookId');
            const id = typeof savedId === 'string' ? savedId : '';
            Reflect.deleteProperty(window, '__continuitySavedHookId');
            if (!id) return;
            const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
            const deleteHook = cache[deleteUrl].default as (input: { id: string; name: string }) => Promise<unknown>;
            await deleteHook({ id, name });
          }, { deleteUrl: MODULE_URLS.deleteHook, name: hookName });
        },
      };
    },
  },
  {
    name: 'studio-main-ensure',
    checks: ['C1', 'C2', 'C5'],
    async prepare(ctx, check) {
      const { page, sessionId, faults } = ctx;
      await preloadModules(page, [MODULE_URLS.studioCollection, MODULE_URLS.studioMainEnsure]);
      const targetMainId = `continuity-main-${Date.now()}`;
      if (check === 'C1' || check === 'C5') {
        faults.stubRequestReply('studio-main-ensure', (_frame, nextSeq) => ({
          reply: { type: 'studio-main-ensure-result', id: sessionId, ok: true, mainId: targetMainId, appliedSeq: nextSeq },
          push: { type: 'director-digest-kept', id: sessionId },
        }));
      }
      await page.evaluate(({ studioUrl, actionUrl, id }) => {
        const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
        const studio = cache[studioUrl].default as { state: { shownSessionId: string | null; pendingMainId: string | null } };
        const readMain = (): string => `${studio.state.shownSessionId ?? ''}:${studio.state.pendingMainId ?? ''}`;
        Reflect.set(window, '__continuityActiveAction', {
          readValue: readMain,
          isOptimisticShown: () => readMain().includes(id),
          fire: () => {
            const runAction = cache[actionUrl].runStudioMainEnsure as (input: { id: string }) => Promise<unknown>;
            Reflect.set(window, '__continuityActionPromise', runAction({ id }));
          },
        });
      }, { studioUrl: MODULE_URLS.studioCollection, actionUrl: MODULE_URLS.studioMainEnsure, id: targetMainId });
      return {
        cleanup: async () => {},
      };
    },
  },
  {
    name: 'update-apply',
    checks: ['C1', 'C2', 'C5'],
    async prepare(ctx, check) {
      const { page, faults } = ctx;
      await preloadModules(page, [MODULE_URLS.settingsBridge, MODULE_URLS.updateApply]);
      await page.evaluate((bridgeUrl) => {
        const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
        const applyError = cache[bridgeUrl].applySettingsUpdateError as (msg: { scope: string; message: string }) => boolean;
        const applyStatus = cache[bridgeUrl].applySettingsUpdateStatus as (status: Record<string, unknown>) => void;
        applyError({ scope: 'update', message: '' });
        applyStatus({ current: '0.66.0', latest: '0.67.0', updateAvailable: true, flavor: 'npm', checkedAt: Date.now() });
        const readState = cache[bridgeUrl].settingsUpdateState as () => { request: { requested: boolean } };
        const readRequested = (): string => String(readState().request.requested);
        Reflect.set(window, '__continuityActiveAction', {
          readValue: readRequested,
          isOptimisticShown: () => readRequested() === 'true',
          fire: () => {
            const requestApply = cache[bridgeUrl].requestUpdateApply as () => Promise<void>;
            Reflect.set(window, '__continuityActionPromise', requestApply());
          },
        });
      }, MODULE_URLS.settingsBridge);
      if (check === 'C1' || check === 'C5') {
        faults.stubRequestReply('update-apply', (_frame, nextSeq) => ({
          reply: { type: 'update-action-result', ok: true, appliedSeq: nextSeq },
          push: { type: 'hooks-updated', count: 0 },
        }));
      }
      return {
        cleanup: async () => {
          await page.evaluate((bridgeUrl) => {
            const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
            const applyError = cache[bridgeUrl].applySettingsUpdateError as (msg: { scope: string; message: string }) => boolean;
            const applyStatus = cache[bridgeUrl].applySettingsUpdateStatus as (status: Record<string, unknown>) => void;
            applyError({ scope: 'update', message: '' });
            applyStatus({ current: '0.66.0', latest: '0.66.0', updateAvailable: false, flavor: 'npm', checkedAt: Date.now() });
          }, MODULE_URLS.settingsBridge);
        },
      };
    },
  },
  {
    name: 'update-check',
    checks: ['C1', 'C2', 'C5'],
    async prepare(ctx, check) {
      const { page, faults } = ctx;
      await preloadModules(page, [MODULE_URLS.settingsBridge, MODULE_URLS.updateCheck]);
      await page.evaluate(({ bridgeUrl, trackCompletion }) => {
        const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
        const applyStatus = cache[bridgeUrl].applySettingsUpdateStatus as (status: Record<string, unknown>) => void;
        applyStatus({ current: '0.66.0', latest: '0.66.0', updateAvailable: false, flavor: 'npm', checkedAt: Date.now() });
        const readState = cache[bridgeUrl].settingsUpdateState as () => {
          isCheckInFlight: boolean;
          lastAutoCheckAt: number | null;
          checkSendFailure: string | null;
        };
        const priorTimestamp = readState().lastAutoCheckAt;
        Reflect.set(window, '__continuityActiveAction', {
          readValue: () => {
            const current = readState();
            if (!trackCompletion) return String(current.isCheckInFlight);
            const completed = current.lastAutoCheckAt !== priorTimestamp && current.checkSendFailure === null;
            return String(current.isCheckInFlight || completed);
          },
          isOptimisticShown: () => readState().isCheckInFlight,
          fire: () => {
            const requestCheck = cache[bridgeUrl].requestUpdateCheck as () => Promise<void>;
            Reflect.set(window, '__continuityActionPromise', requestCheck());
          },
        });
      }, { bridgeUrl: MODULE_URLS.settingsBridge, trackCompletion: check !== 'C2' });
      if (check === 'C1' || check === 'C5') {
        faults.stubRequestReply('update-check', (_frame, nextSeq) => ({
          reply: { type: 'update-action-result', ok: true, appliedSeq: nextSeq },
          push: { type: 'hooks-updated', count: 0 },
        }));
      }
      return {
        cleanup: async () => {
          await page.evaluate((bridgeUrl) => {
            const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
            const applyError = cache[bridgeUrl].applySettingsUpdateError as (msg: { scope: string; message: string }) => boolean;
            const applyStatus = cache[bridgeUrl].applySettingsUpdateStatus as (status: Record<string, unknown>) => void;
            applyError({ scope: 'update', message: '' });
            applyStatus({ current: '0.66.0', latest: '0.66.0', updateAvailable: false, flavor: 'npm', checkedAt: Date.now() });
          }, MODULE_URLS.settingsBridge);
        },
      };
    },
  },
  {
    name: 'update-settings',
    checks: ['C1', 'C2', 'C5'],
    async prepare(ctx) {
      const { page } = ctx;
      await preloadModules(page, [MODULE_URLS.settingsCollection, MODULE_URLS.updateSettings]);
      const initialTz = await page.evaluate(({ settingsUrl, updateUrl }) => {
        const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
        const snapshot = cache[settingsUrl].settingsPayloadSnapshot as () => { operatorTimezone?: string };
        const beforeTz = snapshot().operatorTimezone ?? 'UTC';
        const nextTz = beforeTz === 'America/Denver' ? 'Europe/London' : 'America/Denver';
        const readTz = (): string => snapshot().operatorTimezone ?? '';
        Reflect.set(window, '__continuityActiveAction', {
          readValue: readTz,
          isOptimisticShown: () => readTz() === nextTz,
          fire: () => {
            const runAction = cache[updateUrl].default as (input: { settings: Record<string, unknown> }) => Promise<unknown>;
            Reflect.set(window, '__continuityActionPromise', runAction({ settings: { operatorTimezone: nextTz } }));
          },
        });
        return beforeTz;
      }, { settingsUrl: MODULE_URLS.settingsCollection, updateUrl: MODULE_URLS.updateSettings });
      return {
        cleanup: async () => {
          if ((await readActiveActionValue(page)) === initialTz) return;
          await page.evaluate(async ({ updateUrl, tz }) => {
            const cache = Reflect.get(window, '__continuityModules') as Record<string, Record<string, unknown>>;
            const runAction = cache[updateUrl].default as (input: { settings: Record<string, unknown> }) => Promise<unknown>;
            await runAction({ settings: { operatorTimezone: tz } });
          }, { updateUrl: MODULE_URLS.updateSettings, tz: initialTz });
        },
      };
    },
  },
  ...ACTION_CONTINUITY_STUBS,
];

export const COLLECTION_CONTINUITY_CASES: readonly CollectionContinuityCase[] = [
  {
    name: 'chat-outbox',
    checks: ['C3', 'C4'],
    async prepare(ctx) {
      const { page, layout } = ctx;
      await openFocusBoard(page, layout);
      return {
        listSelector: layout === 'phone' ? '.phone-board-list' : '.focus-rail-list',
        scrollSelector: layout === 'phone' ? '.phone-board-list' : '.focus-rail',
        focusSelector: rosterRowSelector(layout, ctx.sessionId),
        switchAwayAndBack: async () => {
          await openPacksScreen(page, layout);
          await openFocusBoard(page, layout);
        },
        cleanup: async () => {},
      };
    },
  },
  {
    name: 'hooks',
    checks: ['C3', 'C4'],
    async prepare(ctx) {
      const { page, layout } = ctx;
      await openSettingsSection(page, layout, 'Hooks');
      await page.locator('.hooks-panel [data-action="new-hook"]').waitFor({ state: 'visible', timeout: 5000 });
      await page.waitForTimeout(400);
      return {
        listSelector: '.hooks-panel',
        scrollSelector: '.settings-view-main, .settings-view-body',
        focusSelector: '.hooks-panel [data-action="new-hook"]',
        switchAwayAndBack: async () => {
          await openPacksScreen(page, layout);
          await openSettingsSection(page, layout, null);
        },
        verifyAfterReturn: async () => {
          await page.locator('.hooks-panel [data-action="new-hook"]').click();
          const nameInput = page.locator('.hooks-editor input[placeholder="Lint after edits"]');
          await nameInput.waitFor({ state: 'visible', timeout: 5000 });
          const draftName = 'Keep editor draft across view return';
          await nameInput.fill(draftName);
          await openPacksScreen(page, layout);
          await openSettingsSection(page, layout, null);
          const editorState = await page.evaluate((expectedName) => {
            const input = document.querySelector<HTMLInputElement>('.hooks-editor input[placeholder="Lint after edits"]');
            if (!input) return 'open hook editor was lost on view return';
            if (input.value !== expectedName) return `editor draft changed to ${JSON.stringify(input.value)}`;
            if (document.activeElement !== input) return 'editor input lost focus on view return';
            return null;
          }, draftName);
          const cancelButton = page.locator('.hooks-editor [data-action="cancel-hook-edit"]');
          if (await cancelButton.isVisible()) {
            await cancelButton.click();
            const discardButton = page.locator('dialog.dialog [data-action="confirm-dialog"]');
            if (await discardButton.isVisible()) await discardButton.click();
          }
          return editorState;
        },
        cleanup: async () => {},
      };
    },
  },
  {
    name: 'packs',
    checks: ['C3', 'C4'],
    async prepare(ctx) {
      const { page, layout } = ctx;
      await openPacksScreen(page, layout);
      return {
        listSelector: '.packs-grid, .packs-list',
        scrollSelector: '.packs-body',
        focusSelector: '.packs-body button',
        switchAwayAndBack: async () => {
          await openFocusBoard(page, layout);
          await openPacksScreen(page, layout);
        },
        cleanup: async () => {},
      };
    },
  },
  {
    name: 'sessions',
    checks: ['C3', 'C4'],
    async prepare(ctx) {
      const { page, layout, sessionId } = ctx;
      await openFocusBoard(page, layout);
      return {
        listSelector: layout === 'phone' ? '.phone-board-list' : '.focus-rail-list',
        scrollSelector: layout === 'phone' ? '.phone-board-list' : '.focus-rail',
        focusSelector: rosterRowSelector(layout, sessionId),
        switchAwayAndBack: async () => {
          await openPacksScreen(page, layout);
          await openFocusBoard(page, layout);
        },
        cleanup: async () => {},
      };
    },
  },
  {
    name: 'settings',
    checks: ['C3', 'C4'],
    async prepare(ctx) {
      const { page, layout } = ctx;
      await openSettingsSection(page, layout, null);
      if (layout === 'phone') {
        const settingsBack = page.locator('button[data-action="back-to-settings-list"]').first();
        if (await settingsBack.isVisible()) await settingsBack.click();
      }
      return {
        listSelector: '.settings-view-nav',
        scrollSelector: '.settings-view-main, .settings-view-body',
        focusSelector: 'button.settings-view-nav-item',
        switchAwayAndBack: async () => {
          await openPacksScreen(page, layout);
          await openSettingsSection(page, layout, null);
        },
        cleanup: async () => {},
      };
    },
  },
  {
    name: 'studio',
    checks: ['C3', 'C4'],
    async prepare(ctx, check) {
      const { page, layout, sessionId, projectDirectory } = ctx;
      await seedStudioAreaFixture(page, sessionId, projectDirectory);
      if (check === 'C4' && layout !== 'phone') {
        await openStudioScreen(page, layout);
        await page.locator('#view-board-session .bs-pill textarea.chat-composer-input').first().waitFor({ state: 'visible', timeout: 10000 });
        const settleDeadline = Date.now() + 3000;
        while (Date.now() < settleDeadline) {
          ctx.faults.startCountingClientFrames();
          await page.waitForTimeout(250);
          if (ctx.faults.stopCountingClientFrames().length === 0) break;
        }
      }
      return {
        listSelector: '.board-session-view, #view-board-session',
        scrollSelector: '.board-session-view, #view-board-session',
        focusSelector: check === 'C4' && layout !== 'phone'
          ? '#view-board-session .bs-pill textarea.chat-composer-input'
          : '#studio-view button, .board-session-view button',
        switchAwayAndBack: async () => {
          await openPacksScreen(page, layout);
          await openStudioScreen(page, layout);
        },
        cleanup: async () => {},
      };
    },
  },
  ...COLLECTION_CONTINUITY_STUBS,
];
