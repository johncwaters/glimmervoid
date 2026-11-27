import type { Page } from 'playwright-core';
import type { ServerMessage } from '../../shared/contracts/control-messages.ts';
import type { PacksStatus } from '../../shared/contracts/control/pack-messages.ts';
import type { clearHeaderError } from '../../public/action-status.ts';
import type { packsSnapshot } from '../../public/state/collections/packs.ts';
import type { ingestControlMessage } from '../../public/state/ingest.ts';
import type { currentSeq } from '../../public/state/seq.ts';

const PACKS_COLLECTION_URL = '/state/collections/packs.ts';
const INGEST_MODULE_URL = '/state/ingest.ts';
const SEQ_MODULE_URL = '/state/seq.ts';
const ACTION_STATUS_MODULE_URL = '/action-status.ts';

export interface PacksCheckResult {
  ok: boolean;
  detail: string;
}

interface PacksCollectionModule {
  packsSnapshot: typeof packsSnapshot;
}

interface IngestModule {
  ingestControlMessage: typeof ingestControlMessage;
}

interface SeqModule {
  currentSeq: typeof currentSeq;
}

interface ActionStatusModule {
  clearHeaderError: typeof clearHeaderError;
}

async function openPacksView(page: Page): Promise<string | null> {
  const layout = await page.evaluate(() => document.documentElement.dataset.layout ?? 'desktop');
  if (layout === 'phone') {
    const moreButton = page.locator('button.phone-nav-item[aria-expanded]');
    await moreButton.waitFor({ state: 'visible', timeout: 5000 });
    await moreButton.click();
    const packsMenuItem = page.locator('button.phone-nav-menu-item[data-screen="packs"]');
    await packsMenuItem.waitFor({ state: 'visible', timeout: 5000 });
    await packsMenuItem.click();
  }
  if (layout !== 'phone') {
    const packsTab = page.locator('#tab-packs');
    await packsTab.waitFor({ state: 'visible', timeout: 5000 });
    await packsTab.click();
  }
  const packsBody = page.locator('.packs-body');
  await packsBody.waitFor({ state: 'visible', timeout: 5000 });
  return null;
}

export async function verifyPacks(page: Page): Promise<PacksCheckResult> {
  const openError = await openPacksView(page);
  if (openError) return { ok: false, detail: openError };

  return page.evaluate(
    async ({
      packsUrl,
      ingestUrl,
      seqUrl,
      actionStatusUrl,
    }: {
      packsUrl: string;
      ingestUrl: string;
      seqUrl: string;
      actionStatusUrl: string;
    }) => {
      const packsMod = (await import(packsUrl)) as Partial<PacksCollectionModule>;
      const ingestMod = (await import(ingestUrl)) as Partial<IngestModule>;
      const seqMod = (await import(seqUrl)) as Partial<SeqModule>;
      const actionStatusMod = (await import(actionStatusUrl)) as Partial<ActionStatusModule>;

      if (
        typeof packsMod.packsSnapshot !== 'function'
        || typeof ingestMod.ingestControlMessage !== 'function'
        || typeof seqMod.currentSeq !== 'function'
        || typeof actionStatusMod.clearHeaderError !== 'function'
      ) {
        return { ok: false, detail: 'packs state modules are missing expected exports' };
      }

      const currentStatus = packsMod.packsSnapshot();
      const originalStatus = currentStatus
        ? (JSON.parse(JSON.stringify(currentStatus)) as PacksStatus)
        : null;

      const waitForCondition = async (
        predicate: () => boolean,
        timeoutMs: number,
        description: string,
      ): Promise<string | null> => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (predicate()) return null;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return `timed out waiting for ${description}`;
      };

      const findInstalledCardByName = (packName: string): HTMLElement | null => {
        const cards = document.querySelectorAll<HTMLElement>('.packs-card[data-pack-state]');
        for (const card of cards) {
          if (card.querySelector('.packs-card-name')?.textContent?.startsWith(packName)) return card;
        }
        return null;
      };

      try {
        const baseSeq = seqMod.currentSeq();
        const seededStatus: PacksStatus & { seq: number } = {
          type: 'packs-status',
          seq: baseSeq + 1,
          packs: [
            {
              name: 'probe-pending-pack',
              version: 1,
              description: 'Pending pack for harness verification',
              dir: '/tmp/probe-pending-pack',
              state: 'pending',
              fingerprint: 'fp-probe-pending-nonexistent',
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
            },
            {
              name: 'probe-source-pack',
              version: 1,
              description: 'Source-installed pack for harness verification',
              dir: '/tmp/probe-source-pack',
              state: 'approved',
              fingerprint: 'fp-probe-source-approved',
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
            },
          ],
          sources: [
            {
              url: 'https://github.com/example/probe-packs',
              slug: 'probe-source-nonexistent',
              dir: '/tmp/probe-source',
              isBuiltIn: false,
              packs: [
                {
                  name: 'probe-source-pack',
                  dir: '/tmp/probe-source/probe-source-pack',
                  isEnabled: true,
                  version: 1,
                  description: 'Source-installed pack for harness verification',
                  kinds: ['Panel'],
                  iconDataUrl: null,
                  themeSwatches: [],
                  previewDataUrl: null,
                },
              ],
              error: null,
            },
          ],
          themes: [],
          panels: [],
          launchers: [],
          providers: [],
          warnings: [],
        };

        const route = ingestMod.ingestControlMessage(seededStatus as ServerMessage);
        if (route !== 'collection') {
          return { ok: false, detail: `expected packs-status route "collection", got ${route}` };
        }

        const pendingCardError = await waitForCondition(
          () => findInstalledCardByName('probe-pending-pack')?.dataset.packState === 'pending',
          2000,
          'probe-pending-pack card in pending state',
        );
        if (pendingCardError) return { ok: false, detail: pendingCardError };

        const approveOpenButton = findInstalledCardByName('probe-pending-pack')
          ?.querySelector<HTMLButtonElement>('button[data-action="pack-approve"]');
        if (!approveOpenButton) {
          return { ok: false, detail: 'Approve button missing on probe-pending-pack card' };
        }
        approveOpenButton.click();

        const dialogApproveError = await waitForCondition(
          () => document.querySelector<HTMLButtonElement>('.packs-detail-dialog button[data-action="pack-approve"]') !== null,
          2000,
          'pack detail dialog Approve button',
        );
        if (dialogApproveError) return { ok: false, detail: dialogApproveError };

        const dialogApproveButton = document.querySelector<HTMLButtonElement>(
          '.packs-detail-dialog button[data-action="pack-approve"]',
        );
        if (!dialogApproveButton) return { ok: false, detail: 'dialog Approve button missing' };

        let sawOptimisticApproved = false;
        const approveObserver = new MutationObserver(() => {
          if (findInstalledCardByName('probe-pending-pack')?.dataset.packState === 'approved') {
            sawOptimisticApproved = true;
          }
        });
        const packsBody = document.querySelector('.packs-body');
        if (packsBody) approveObserver.observe(packsBody, { childList: true, subtree: true, attributes: true });

        dialogApproveButton.click();
        if (findInstalledCardByName('probe-pending-pack')?.dataset.packState === 'approved') {
          sawOptimisticApproved = true;
        }

        const approveRollbackError = await waitForCondition(
          () => {
            const card = findInstalledCardByName('probe-pending-pack');
            const notice = document.getElementById('header-error-notice');
            return card?.dataset.packState === 'pending' && Boolean(notice && !notice.hidden);
          },
          5000,
          'pack-approve rollback to pending with visible header notice',
        );
        approveObserver.disconnect();
        if (!sawOptimisticApproved) {
          return { ok: false, detail: 'pack-approve did not optimistically mark probe-pending-pack as approved' };
        }
        if (approveRollbackError) return { ok: false, detail: approveRollbackError };

        document.querySelector<HTMLElement>('.dialog-overlay')?.click();
        actionStatusMod.clearHeaderError('Approve pack');

        const removeSourceButton = findInstalledCardByName('probe-source-pack')
          ?.querySelector<HTMLButtonElement>('button[data-action="pack-source-disable"]');
        if (!removeSourceButton) {
          return { ok: false, detail: 'Remove button missing on probe-source-pack card' };
        }

        let sawOptimisticRemoved = false;
        const removeObserver = new MutationObserver(() => {
          if (findInstalledCardByName('probe-source-pack') === null) {
            sawOptimisticRemoved = true;
          }
        });
        if (packsBody) removeObserver.observe(packsBody, { childList: true, subtree: true });

        removeSourceButton.click();
        if (findInstalledCardByName('probe-source-pack') === null) {
          sawOptimisticRemoved = true;
        }

        const removeRollbackError = await waitForCondition(
          () => {
            const card = findInstalledCardByName('probe-source-pack');
            const notice = document.getElementById('header-error-notice');
            return card !== null && Boolean(notice && !notice.hidden);
          },
          5000,
          'pack-source-enable(false) rollback restoring probe-source-pack with visible header notice',
        );
        removeObserver.disconnect();
        if (!sawOptimisticRemoved) {
          return { ok: false, detail: 'pack-source-enable(false) did not optimistically remove probe-source-pack' };
        }
        if (removeRollbackError) return { ok: false, detail: removeRollbackError };

        return {
          ok: true,
          detail: 'packs collection ingest, optimistic approve + rollback, and optimistic remove + rollback verified',
        };
      } catch (caughtError) {
        const message = caughtError instanceof Error
          ? `${caughtError.name}: ${caughtError.message}`
          : String(caughtError);
        return { ok: false, detail: `uncaught error: ${message}` };
      } finally {
        document.querySelector<HTMLElement>('.dialog-overlay')?.click();
        actionStatusMod.clearHeaderError('Approve pack');
        actionStatusMod.clearHeaderError('Remove pack folder');
        actionStatusMod.clearHeaderError('Remove pack source');
        actionStatusMod.clearHeaderError('Packs');
        if (originalStatus) {
          ingestMod.ingestControlMessage({
            ...originalStatus,
            seq: seqMod.currentSeq() + 1,
          } as ServerMessage);
        }
      }
    },
    {
      packsUrl: PACKS_COLLECTION_URL,
      ingestUrl: INGEST_MODULE_URL,
      seqUrl: SEQ_MODULE_URL,
      actionStatusUrl: ACTION_STATUS_MODULE_URL,
    },
  );
}
