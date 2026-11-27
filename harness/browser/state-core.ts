import type { Page } from 'playwright-core';
import type { ServerMessage } from '../../shared/contracts/control-messages.ts';
import type { clearHeaderError } from '../../public/action-status.ts';
import type {
  ActionOptions,
  ActionResult,
  ControlRequester,
  MutatingClientMessageType,
  OptimisticApplier,
  defineAction,
} from '../../public/state/define-action.ts';
import type {
  CollectionHandle,
  CollectionHelpers,
  CollectionKey,
  CollectionOptions,
  defineCollection,
  unregisterCollection,
} from '../../public/state/define-collection.ts';
import type { ingestControlMessage } from '../../public/state/ingest.ts';
import type {
  PersistedOptions,
  PersistedValue,
  cleanupSessionPersistedKeys,
  definePersisted,
} from '../../public/state/persist.ts';
import type { currentSeq, whenSeqReached } from '../../public/state/seq.ts';

const SEQ_MODULE_URL = '/state/seq.ts';
const PERSIST_MODULE_URL = '/state/persist.ts';
const COLLECTION_MODULE_URL = '/state/define-collection.ts';
const INGEST_MODULE_URL = '/state/ingest.ts';
const ACTION_MODULE_URL = '/state/define-action.ts';
const ACTION_STATUS_MODULE_URL = '/action-status.ts';

export interface StateCoreCheckResult {
  ok: boolean;
  detail: string;
}

interface SeqModule {
  currentSeq: typeof currentSeq;
  whenSeqReached: typeof whenSeqReached;
}

interface PersistModule {
  definePersisted: typeof definePersisted;
  cleanupSessionPersistedKeys: typeof cleanupSessionPersistedKeys;
}

interface CollectionModule {
  defineCollection: typeof defineCollection;
  unregisterCollection: typeof unregisterCollection;
}

interface IngestModule {
  ingestControlMessage: typeof ingestControlMessage;
}

interface ActionModule {
  defineAction: typeof defineAction;
}

interface ActionStatusModule {
  clearHeaderError: typeof clearHeaderError;
}

type StateCoreTypeCheck = [
  ActionOptions,
  ActionResult,
  ControlRequester,
  MutatingClientMessageType,
  OptimisticApplier,
  CollectionHandle<object>,
  CollectionHelpers,
  CollectionKey,
  CollectionOptions<object>,
  PersistedOptions<unknown>,
  PersistedValue<unknown>,
];

const _ensureTypesReferenced: StateCoreTypeCheck | null = null;
void _ensureTypesReferenced;

export async function verifyStateCore(page: Page): Promise<StateCoreCheckResult> {
  return page.evaluate(
    async ({
      seqUrl,
      persistUrl,
      collectionUrl,
      ingestUrl,
      actionUrl,
      actionStatusUrl,
    }: {
      seqUrl: string;
      persistUrl: string;
      collectionUrl: string;
      ingestUrl: string;
      actionUrl: string;
      actionStatusUrl: string;
    }) => {
      const seqMod = (await import(seqUrl)) as Partial<SeqModule>;
      const persistMod = (await import(persistUrl)) as Partial<PersistModule>;
      const collectionMod = (await import(collectionUrl)) as Partial<CollectionModule>;
      const ingestMod = (await import(ingestUrl)) as Partial<IngestModule>;
      const actionMod = (await import(actionUrl)) as Partial<ActionModule>;
      const actionStatusMod = (await import(actionStatusUrl)) as Partial<ActionStatusModule>;

      if (
        typeof seqMod.currentSeq !== 'function'
        || typeof seqMod.whenSeqReached !== 'function'
        || typeof persistMod.definePersisted !== 'function'
        || typeof persistMod.cleanupSessionPersistedKeys !== 'function'
        || typeof collectionMod.defineCollection !== 'function'
        || typeof collectionMod.unregisterCollection !== 'function'
        || typeof ingestMod.ingestControlMessage !== 'function'
        || typeof actionMod.defineAction !== 'function'
        || typeof actionStatusMod.clearHeaderError !== 'function'
      ) {
        return { ok: false, detail: 'one or more public/state/ exports are missing' };
      }

      const flushMicrotasks = async (): Promise<void> => {
        await Promise.resolve();
        await Promise.resolve();
      };

      const noticeSource = 'StateCoreProbe';
      const persistKey = 'glimmervoid-state-core-probe-value';
      const sessionPrefix = 'glimmervoid-state-core-probe-session:';

      try {
        const baseSeq = seqMod.currentSeq();
        const collection = collectionMod.defineCollection<{ items: Array<{ id: string; count: number }> }>({
          name: 'wargames',
          key: 'id',
          initial: { items: [{ id: 'h1', count: 1 }] },
          apply(_draft, message, { replace }) {
            if (message.type !== 'wargames-status') return;
            replace({ items: [{ id: 'h1', count: message.matches.length }] });
          },
        });

        const readCount = (): number | undefined => collection.state.items[0]?.count;

        await flushMicrotasks();
        if (readCount() !== 1) {
          return { ok: false, detail: `unexpected initial collection count: ${String(readCount())}` };
        }

        const makeProbeMatches = (count: number) => Array.from({ length: count }, (_, index) => ({
          id: `probe-${index}`,
        })) as never;

        const firstPushSeq = baseSeq + 10;
        const firstPush: ServerMessage = {
          type: 'wargames-status',
          seq: firstPushSeq,
          matches: makeProbeMatches(5),
        };
        const collectionRoute = ingestMod.ingestControlMessage(firstPush);

        await flushMicrotasks();
        if (collectionRoute !== 'collection') {
          return { ok: false, detail: `expected registered collection route "collection", got ${collectionRoute}` };
        }
        if (seqMod.currentSeq() !== firstPushSeq) {
          return { ok: false, detail: `expected currentSeq ${firstPushSeq}, got ${seqMod.currentSeq()}` };
        }
        if (readCount() !== 5) {
          return { ok: false, detail: `collection did not reconcile server push: ${String(readCount())}` };
        }

        const unregisteredPush: ServerMessage = {
          type: 'whiteboard-removed',
          seq: firstPushSeq + 1,
          boardId: 'wb-probe-nonexistent',
        };
        const legacyRoute = ingestMod.ingestControlMessage(unregisteredPush);
        if (legacyRoute !== 'legacy') {
          return { ok: false, detail: `expected unregistered collection route "legacy", got ${legacyRoute}` };
        }

        let resolveSuccessReply: (reply: ServerMessage) => void = () => {};
        const appliedSeq = firstPushSeq + 20;
        const runSave = actionMod.defineAction<{ count: number }>({
          type: 'save-hook',
          noticeSource,
          rollbackNotice: 'Save hook rolled back',
          optimistic(input, apply) {
            apply(collection, (draft) => {
              draft.items[0].count = input.count;
            });
          },
          request: () => new Promise<ServerMessage>((resolve) => {
            resolveSuccessReply = resolve;
          }),
        });

        let actionSettled = false;
        const actionPromise = runSave({ count: 42 }).then((actionOutcome) => {
          actionSettled = true;
          return actionOutcome;
        });

        await flushMicrotasks();
        if (readCount() !== 42) {
          return { ok: false, detail: `optimistic overlay did not appear immediately: ${String(readCount())}` };
        }

        resolveSuccessReply({
          type: 'save-hook-result',
          requestId: 'state-core-1',
          ok: true,
          appliedSeq,
        } as ServerMessage);

        await flushMicrotasks();
        if (actionSettled) {
          return { ok: false, detail: 'action settled before appliedSeq was reached' };
        }
        if (readCount() !== 42) {
          return { ok: false, detail: `optimistic overlay dropped before appliedSeq: ${String(readCount())}` };
        }

        const earlierConcurrentPush: ServerMessage = {
          type: 'wargames-status',
          seq: appliedSeq - 5,
          matches: makeProbeMatches(7),
        };
        ingestMod.ingestControlMessage(earlierConcurrentPush);
        await flushMicrotasks();
        if (actionSettled) {
          return { ok: false, detail: 'action settled on earlier concurrent push below appliedSeq' };
        }
        if (readCount() !== 42) {
          return { ok: false, detail: `earlier concurrent push wiped optimistic overlay: ${String(readCount())}` };
        }

        const confirmedPush: ServerMessage = {
          type: 'wargames-status',
          seq: appliedSeq,
          matches: makeProbeMatches(99),
        };
        ingestMod.ingestControlMessage(confirmedPush);

        const successResult = await actionPromise;
        await flushMicrotasks();
        if (!successResult.ok) {
          return { ok: false, detail: `expected action success, got error: ${successResult.error.message}` };
        }
        if (readCount() !== 99) {
          return { ok: false, detail: `collection did not settle to server truth: ${String(readCount())}` };
        }

        const runTimeout = actionMod.defineAction<{ count: number }>({
          type: 'save-hook',
          noticeSource,
          timeoutMs: 80,
          rollbackNotice: (error) => `Timed out: ${error instanceof Error ? error.message : String(error)}`,
          optimistic(input, apply) {
            apply(collection, (draft) => {
              draft.items[0].count = input.count;
            });
          },
          request: async () => ({
            type: 'save-hook-result',
            requestId: 'state-core-timeout',
            ok: true,
            appliedSeq: appliedSeq + 500,
          }),
        });
        const timeoutResult = await runTimeout({ count: 555 });
        await flushMicrotasks();
        if (timeoutResult.ok) {
          return { ok: false, detail: 'expected timeout when appliedSeq never arrived' };
        }
        if (readCount() !== 99) {
          return { ok: false, detail: `timed-out action did not roll back overlay: ${String(readCount())}` };
        }
        if (!timeoutResult.error.message.includes('did not answer within')) {
          return { ok: false, detail: `expected formatted timeout message, got: ${timeoutResult.error.message}` };
        }

        let resolveFailReply: (reply: ServerMessage) => void = () => {};
        const runFail = actionMod.defineAction<{ count: number }>({
          type: 'save-hook',
          noticeSource,
          rollbackNotice: (error) => `Failed: ${error instanceof Error ? error.message : String(error)}`,
          optimistic(input, apply) {
            apply(collection, (draft) => {
              draft.items[0].count = input.count;
            });
          },
          request: () => new Promise<ServerMessage>((resolve) => {
            resolveFailReply = resolve;
          }),
        });

        const failPromise = runFail({ count: 777 });
        await flushMicrotasks();
        if (readCount() !== 777) {
          return { ok: false, detail: `optimistic overlay for fail path did not appear: ${String(readCount())}` };
        }

        const failReply: ServerMessage = {
          type: 'save-hook-result',
          requestId: 'state-core-2',
          ok: false,
          error: 'hook rejected',
          appliedSeq: appliedSeq + 1,
        };
        resolveFailReply(failReply);

        const failResult = await failPromise;
        await flushMicrotasks();
        if (failResult.ok) {
          return { ok: false, detail: 'expected failed action result, got ok=true' };
        }
        if (readCount() !== 99) {
          return { ok: false, detail: `failed action did not roll back overlay: ${String(readCount())}` };
        }

        const noticeElement = document.getElementById('header-error-notice');
        if (!noticeElement || noticeElement.hidden) {
          return { ok: false, detail: 'rollback notice #header-error-notice is not visible after action failure' };
        }
        const noticeText = noticeElement.textContent ?? '';
        if (!noticeText.includes('hook rejected')) {
          return { ok: false, detail: `unexpected rollback notice text: ${JSON.stringify(noticeText)}` };
        }

        const stringSchema = {
          safeParse: (value: unknown) => (
            typeof value === 'string'
              ? { success: true as const, data: value }
              : { success: false as const }
          ),
          parse: (value: unknown) => {
            if (typeof value !== 'string') throw new Error('not a string');
            return value;
          },
        };
        const persisted = persistMod.definePersisted<string>({
          key: persistKey,
          schema: stringSchema,
          fallback: 'fallback-val',
        });
        if (persisted.read() !== 'fallback-val') {
          return { ok: false, detail: `expected fallback-val, got ${JSON.stringify(persisted.read())}` };
        }
        persisted.write('persisted-val');
        await flushMicrotasks();
        if (persisted.read() !== 'persisted-val') {
          return { ok: false, detail: `expected persisted-val after write, got ${JSON.stringify(persisted.read())}` };
        }
        persisted.clear();
        await flushMicrotasks();
        if (persisted.read() !== 'fallback-val') {
          return { ok: false, detail: `expected fallback-val after clear, got ${JSON.stringify(persisted.read())}` };
        }

        const liveSessionKey = persistMod.definePersisted<string>({
          key: `${sessionPrefix}live-1`,
          schema: stringSchema,
          fallback: '',
        });
        const deadSessionKey = persistMod.definePersisted<string>({
          key: `${sessionPrefix}dead-1`,
          schema: stringSchema,
          fallback: '',
        });
        liveSessionKey.write('keep');
        deadSessionKey.write('drop');
        persistMod.cleanupSessionPersistedKeys(sessionPrefix, new Set(['live-1']));
        if (window.localStorage.getItem(`${sessionPrefix}live-1`) === null) {
          return { ok: false, detail: 'cleanupSessionPersistedKeys removed live session key' };
        }
        if (window.localStorage.getItem(`${sessionPrefix}dead-1`) !== null) {
          return { ok: false, detail: 'cleanupSessionPersistedKeys left dead session key behind' };
        }

        return {
          ok: true,
          detail: 'ingest, defineCollection, defineAction (optimistic, appliedSeq hold, rollback notice), seq, and persist verified',
        };
      } catch (caughtError) {
        const message = caughtError instanceof Error
          ? `${caughtError.name}: ${caughtError.message}\n${caughtError.stack ?? ''}`
          : String(caughtError);
        return { ok: false, detail: `uncaught error: ${message}` };
      } finally {
        collectionMod.unregisterCollection('wargames');
        actionStatusMod.clearHeaderError(noticeSource);
        window.localStorage.removeItem(persistKey);
        window.localStorage.removeItem(`${sessionPrefix}live-1`);
        window.localStorage.removeItem(`${sessionPrefix}dead-1`);
      }
    },
    {
      seqUrl: SEQ_MODULE_URL,
      persistUrl: PERSIST_MODULE_URL,
      collectionUrl: COLLECTION_MODULE_URL,
      ingestUrl: INGEST_MODULE_URL,
      actionUrl: ACTION_MODULE_URL,
      actionStatusUrl: ACTION_STATUS_MODULE_URL,
    },
  );
}
