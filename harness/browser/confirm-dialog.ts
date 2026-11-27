import type { ConsoleMessage, Page } from 'playwright-core';

const SOLID_DIAGNOSTIC_PATTERN = /^\[[A-Z][A-Z0-9_]+\]/;

const MODAL_MODULE_URL = '/session-card/modal.ts';
const ISLAND_MODULE_URL = '/ui/island.ts';
const DIALOG_MODULE_URL = '/ui/Dialog.tsx';
const DIFF_PANEL_MODULE_URL = '/board-session/studio-diff-panel.ts';

export interface ConfirmDialogCheckResult {
  ok: boolean;
  detail: string;
}

interface ModalRuntime {
  openConfirmDialog: (options: {
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    onConfirm?: () => void;
  }) => void;
  createModalOverlay: (options?: { dialogClass?: string; closeOnBackdrop?: boolean }) => {
    overlay: HTMLDivElement;
    dialog: HTMLDivElement;
    close: () => void;
  };
  isModalOpen: () => boolean;
}

interface ProbeState {
  confirmCount: number;
  opener: HTMLButtonElement;
  legacyClose: (() => void) | null;
  legacyButton: HTMLButtonElement | null;
}

interface ProbeWindow extends Window {
  __glimmervoidConfirmProbe?: ProbeState;
  __docEscCleanup?: () => boolean;
  __noEscCleanup?: () => void;
  __diffPanelProbe?: { element: HTMLElement; close: () => void };
}

export async function verifyConfirmDialog(page: Page): Promise<ConfirmDialogCheckResult> {
  const solidDiagnostics: string[] = [];
  const onConsole = (message: ConsoleMessage): void => {
    const type = message.type();
    if (type !== 'warning' && type !== 'error') return;
    const text = message.text().trim();
    if (SOLID_DIAGNOSTIC_PATTERN.test(text)) solidDiagnostics.push(text);
  };
  page.on('console', onConsole);
  try {
    const confirmOutcome = await runConfirmDialogChecks(page);
    if (!confirmOutcome.ok) return confirmOutcome;
    if (solidDiagnostics.length > 0) {
      return { ok: false, detail: `unexpected Solid 2 diagnostic in confirm-dialog: ${solidDiagnostics[0]}` };
    }
    return confirmOutcome;
  } finally {
    page.off('console', onConsole);
  }
}

async function runConfirmDialogChecks(page: Page): Promise<ConfirmDialogCheckResult> {
  const setupError = await page.evaluate(async (modalUrl: string) => {
    const modal = (await import(modalUrl)) as Partial<ModalRuntime>;
    if (typeof modal.openConfirmDialog !== 'function' || typeof modal.isModalOpen !== 'function' || typeof modal.createModalOverlay !== 'function') {
      return 'modal.ts exports are missing';
    }
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.dataset.confirmProbeOpener = 'true';
    opener.textContent = 'Open confirm probe';
    document.body.appendChild(opener);
    (window as ProbeWindow).__glimmervoidConfirmProbe = {
      confirmCount: 0,
      opener,
      legacyClose: null,
      legacyButton: null,
    };
    return null;
  }, MODAL_MODULE_URL);

  if (setupError) return { ok: false, detail: setupError };

  const opener = page.locator('[data-confirm-probe-opener="true"]');
  const dialog = page.locator('dialog.dialog');

  const cleanupProbe = async () => {
    await page.evaluate(() => {
      const probe = (window as ProbeWindow).__glimmervoidConfirmProbe;
      probe?.legacyClose?.();
      probe?.opener.remove();
      delete (window as ProbeWindow).__glimmervoidConfirmProbe;
      const diffPanelProbe = (window as ProbeWindow).__diffPanelProbe;
      diffPanelProbe?.close();
      diffPanelProbe?.element.remove();
      delete (window as ProbeWindow).__diffPanelProbe;
    });
  };

  try {
    await opener.focus();
    await page.evaluate(async (modalUrl: string) => {
      const modal = (await import(modalUrl)) as ModalRuntime;
      const probe = (window as ProbeWindow).__glimmervoidConfirmProbe;
      if (!probe) return;
      modal.openConfirmDialog({
        title: 'Restart Server',
        message: 'Restart the server?',
        onConfirm: () => { probe.confirmCount += 1; },
      });
    }, MODAL_MODULE_URL);

    await dialog.waitFor({ state: 'visible' });

    const defaultCheck = await page.evaluate(async (modalUrl: string) => {
      const modal = (await import(modalUrl)) as ModalRuntime;
      const el = document.querySelector<HTMLDialogElement>('dialog.dialog');
      if (!el) return 'dialog.dialog missing';
      if (!el.open || !el.matches(':modal')) return 'dialog did not open with showModal()';
      if (!modal.isModalOpen()) return 'isModalOpen() returned false while native dialog is open';
      const titleId = el.getAttribute('aria-labelledby');
      const titleEl = titleId ? document.getElementById(titleId) : null;
      if (titleEl?.textContent !== 'Restart Server') return `unexpected aria-labelledby title: ${titleEl?.textContent}`;
      if (el.querySelector('.dialog-message')?.textContent !== 'Restart the server?') return 'unexpected dialog message';
      const buttons = [...el.querySelectorAll<HTMLButtonElement>('.dialog-actions button')];
      if (buttons.length !== 2) return `expected 2 action buttons, got ${buttons.length}`;
      const [cancelBtn, confirmBtn] = buttons;
      if (cancelBtn.textContent !== 'Cancel' || cancelBtn.dataset.variant !== 'secondary') return 'unexpected cancel button';
      if (confirmBtn.textContent !== 'Confirm' || confirmBtn.dataset.variant !== 'primary' || confirmBtn.dataset.action !== 'confirm-dialog') {
        return 'unexpected default confirm button';
      }
      if (document.activeElement !== cancelBtn) return `expected initial focus on Cancel, got ${document.activeElement?.textContent}`;
      const rect = el.getBoundingClientRect();
      const layout = document.documentElement.dataset.layout;
      if (rect.width <= 0 || rect.height <= 0 || rect.right > window.innerWidth + 1) {
        return `dialog geometry out of viewport: ${JSON.stringify(rect)}`;
      }
      if (layout === 'phone' && (rect.top < 12 || rect.top > 64)) {
        return `phone dialog not aligned near top: top=${rect.top}`;
      }
      if (layout === 'desktop') {
        const centerDiffY = Math.abs((rect.top + rect.height / 2) - window.innerHeight / 2);
        if (centerDiffY > 40) return `desktop dialog not vertically centered: centerDiffY=${centerDiffY}`;
      }
      return null;
    }, MODAL_MODULE_URL);
    if (defaultCheck) return { ok: false, detail: defaultCheck };

    await page.keyboard.press('Tab');
    const focusedConfirm = await page.evaluate(() => document.activeElement?.getAttribute('data-action') === 'confirm-dialog');
    if (!focusedConfirm) return { ok: false, detail: 'Tab did not move focus from Cancel to Confirm' };

    await page.keyboard.press('Shift+Tab');
    const focusedCancelAgain = await page.evaluate(() => document.activeElement?.textContent === 'Cancel');
    if (!focusedCancelAgain) return { ok: false, detail: 'Shift+Tab did not move focus back to Cancel' };

    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'detached' });

    const afterCancelError = await page.evaluate(async (modalUrl: string) => {
      const modal = (await import(modalUrl)) as ModalRuntime;
      const probe = (window as ProbeWindow).__glimmervoidConfirmProbe;
      if (!probe) return 'probe missing';
      if (probe.confirmCount !== 0) return `Enter on Cancel triggered onConfirm (${probe.confirmCount})`;
      if (modal.isModalOpen()) return 'isModalOpen() stayed true after Cancel';
      if (document.activeElement !== probe.opener) return 'focus did not return to opener after Cancel';
      return null;
    }, MODAL_MODULE_URL);
    if (afterCancelError) return { ok: false, detail: afterCancelError };

    await page.evaluate(async (modalUrl: string) => {
      const modal = (await import(modalUrl)) as ModalRuntime;
      const probe = (window as ProbeWindow).__glimmervoidConfirmProbe;
      if (!probe) return;
      modal.openConfirmDialog({
        title: 'Delete board',
        message: 'Delete for good?',
        confirmLabel: 'Delete board',
        danger: true,
        onConfirm: () => { probe.confirmCount += 1; },
      });
    }, MODAL_MODULE_URL);

    await dialog.waitFor({ state: 'visible' });
    const dangerCheck = await page.evaluate(() => {
      const confirmBtn = document.querySelector<HTMLButtonElement>('dialog.dialog [data-action="confirm-dialog"]');
      if (!confirmBtn) return 'danger confirm button missing';
      if (confirmBtn.dataset.variant !== 'danger') return `expected danger variant, got ${confirmBtn.dataset.variant}`;
      if (confirmBtn.textContent !== 'Delete board') return `expected Delete board label, got ${confirmBtn.textContent}`;
      return null;
    });
    if (dangerCheck) return { ok: false, detail: dangerCheck };

    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'detached' });

    const afterConfirmError = await page.evaluate(async (modalUrl: string) => {
      const modal = (await import(modalUrl)) as ModalRuntime;
      const probe = (window as ProbeWindow).__glimmervoidConfirmProbe;
      if (!probe) return 'probe missing';
      if (probe.confirmCount !== 1) return `expected onConfirm count 1, got ${probe.confirmCount}`;
      if (modal.isModalOpen()) return 'isModalOpen() stayed true after Confirm';
      if (document.activeElement !== probe.opener) return 'focus did not return to opener after Confirm';
      return null;
    }, MODAL_MODULE_URL);
    if (afterConfirmError) return { ok: false, detail: afterConfirmError };

    await page.evaluate(async (modalUrl: string) => {
      const modal = (await import(modalUrl)) as ModalRuntime;
      const probe = (window as ProbeWindow).__glimmervoidConfirmProbe;
      if (!probe) return;
      modal.openConfirmDialog({
        title: 'Remove key',
        message: 'Delete signing key?',
        confirmLabel: 'Remove',
        danger: true,
        onConfirm: () => { probe.confirmCount += 1; },
      });
    }, MODAL_MODULE_URL);

    await dialog.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });

    const afterEscapeError = await page.evaluate(async (modalUrl: string) => {
      const modal = (await import(modalUrl)) as ModalRuntime;
      const probe = (window as ProbeWindow).__glimmervoidConfirmProbe;
      if (!probe) return 'probe missing';
      if (probe.confirmCount !== 1) return `Escape triggered onConfirm (${probe.confirmCount})`;
      if (modal.isModalOpen()) return 'isModalOpen() stayed true after Escape';
      if (document.activeElement !== probe.opener) return 'focus did not return to opener after Escape';
      return null;
    }, MODAL_MODULE_URL);
    if (afterEscapeError) return { ok: false, detail: afterEscapeError };

    await page.evaluate(async (modalUrl: string) => {
      const modal = (await import(modalUrl)) as ModalRuntime;
      const probe = (window as ProbeWindow).__glimmervoidConfirmProbe;
      if (!probe) return;
      modal.openConfirmDialog({
        title: 'Discard edits',
        message: 'Unsaved edits will be lost.',
        confirmLabel: 'Discard',
        danger: true,
        onConfirm: () => { probe.confirmCount += 1; },
      });
    }, MODAL_MODULE_URL);

    await dialog.waitFor({ state: 'visible' });
    const box = await dialog.boundingBox();
    if (!box) return { ok: false, detail: 'dialog boundingBox missing for backdrop test' };
    await page.mouse.click(box.x + 6, box.y + 6);
    if (!(await dialog.isVisible())) return { ok: false, detail: 'clicking inside dialog padding closed it' };

    const messageBox = await dialog.locator('.dialog-message').boundingBox();
    if (!messageBox) return { ok: false, detail: 'dialog-message boundingBox missing' };
    await page.mouse.move(messageBox.x + 8, messageBox.y + 8);
    await page.mouse.down();
    await page.mouse.move(2, 2);
    await page.mouse.up();
    if (!(await dialog.isVisible())) return { ok: false, detail: 'dragging selection out of dialog closed it as a backdrop click' };

    await page.mouse.click(2, 2);
    await dialog.waitFor({ state: 'detached' });

    const afterBackdropError = await page.evaluate(async (modalUrl: string) => {
      const modal = (await import(modalUrl)) as ModalRuntime;
      const probe = (window as ProbeWindow).__glimmervoidConfirmProbe;
      if (!probe) return 'probe missing';
      if (probe.confirmCount !== 1) return `backdrop click triggered onConfirm (${probe.confirmCount})`;
      if (modal.isModalOpen()) return 'isModalOpen() stayed true after backdrop click';
      if (document.activeElement !== probe.opener) return 'focus did not return to opener after backdrop click';
      return null;
    }, MODAL_MODULE_URL);
    if (afterBackdropError) return { ok: false, detail: afterBackdropError };

    await page.evaluate(async (modalUrl: string) => {
      const modal = (await import(modalUrl)) as ModalRuntime;
      const probe = (window as ProbeWindow).__glimmervoidConfirmProbe;
      if (!probe) return;
      const legacy = modal.createModalOverlay();
      const legacyBtn = document.createElement('button');
      legacyBtn.type = 'button';
      legacyBtn.textContent = 'Legacy opener';
      legacy.dialog.appendChild(legacyBtn);
      legacyBtn.focus();
      probe.legacyClose = legacy.close;
      probe.legacyButton = legacyBtn;
      modal.openConfirmDialog({
        title: 'Stacked confirm',
        message: 'Confirm over legacy modal?',
        confirmLabel: 'Proceed',
        onConfirm: () => { probe.confirmCount += 1; },
      });
    }, MODAL_MODULE_URL);

    await dialog.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });

    const afterStackedError = await page.evaluate(async (modalUrl: string) => {
      const modal = (await import(modalUrl)) as ModalRuntime;
      const probe = (window as ProbeWindow).__glimmervoidConfirmProbe;
      if (!probe) return 'probe missing';
      if (!document.querySelector('.dialog-overlay')) return 'Escape closed the underlying legacy overlay too';
      if (!modal.isModalOpen()) return 'isModalOpen() returned false while legacy overlay stayed open';
      if (document.activeElement !== probe.legacyButton) return 'focus did not return to legacy modal button';
      probe.legacyClose?.();
      probe.legacyClose = null;
      if (modal.isModalOpen()) return 'isModalOpen() stayed true after closing legacy overlay';
      return null;
    }, MODAL_MODULE_URL);
    if (afterStackedError) return { ok: false, detail: afterStackedError };

    const escapeCaptureError = await page.evaluate(async (modalUrl: string) => {
      const modal = (await import(modalUrl)) as ModalRuntime;
      let documentSawEscape = false;
      const listener = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        documentSawEscape = true;
        event.preventDefault();
      };
      document.addEventListener('keydown', listener);
      modal.openConfirmDialog({
        title: 'Escape isolation',
        message: 'Document keydown should not swallow Escape.',
      });
      (window as ProbeWindow).__docEscCleanup = () => {
        document.removeEventListener('keydown', listener);
        return documentSawEscape;
      };
      return null;
    }, MODAL_MODULE_URL);
    if (escapeCaptureError) return { ok: false, detail: escapeCaptureError };

    await dialog.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    const documentSawEscape = await page.evaluate(() => {
      const probeWin = window as ProbeWindow;
      const fn = probeWin.__docEscCleanup;
      delete probeWin.__docEscCleanup;
      return fn ? fn() : false;
    });
    if (documentSawEscape) return { ok: false, detail: 'Escape bubbled to document listener while native dialog was open' };

    await page.evaluate(async ({ islandUrl, dialogUrl }: { islandUrl: string; dialogUrl: string }) => {
      const [{ mountIsland }, { Dialog }] = await Promise.all([
        import(islandUrl),
        import(dialogUrl),
      ]);
      const host = document.createElement('div');
      document.body.appendChild(host);
      const dispose = mountIsland(host, () => Dialog({
        title: 'No Escape',
        message: 'Escape disabled',
        closeOnEscape: false,
        open: true,
      }));
      (window as ProbeWindow).__noEscCleanup = () => {
        dispose();
        host.remove();
      };
    }, { islandUrl: ISLAND_MODULE_URL, dialogUrl: DIALOG_MODULE_URL });
    await dialog.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const stillOpenNoEsc = await page.evaluate(() => {
      const el = document.querySelector<HTMLDialogElement>('dialog.dialog');
      const open = Boolean(el?.open);
      const probeWin = window as ProbeWindow;
      const cleanup = probeWin.__noEscCleanup;
      delete probeWin.__noEscCleanup;
      cleanup?.();
      return open;
    });
    if (!stillOpenNoEsc) return { ok: false, detail: 'repeated Escape bypassed closeOnEscape=false' };

    await page.evaluate(async (modalUrl: string) => {
      const modal = (await import(modalUrl)) as ModalRuntime;
      const legacy = modal.createModalOverlay();
      modal.openConfirmDialog({
        title: 'Legacy closes underneath',
        message: 'Confirm stays interactive and app un-inerts.',
      });
      legacy.close();
    }, MODAL_MODULE_URL);
    await dialog.waitFor({ state: 'visible' });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    const inertAfterLegacyCloseError = await page.evaluate(() => {
      const anyInert = [...document.body.children].some((child) => child instanceof HTMLElement && child.inert);
      return anyInert ? 'document.body child remained inert after closing legacy + native dialog' : null;
    });
    if (inertAfterLegacyCloseError) return { ok: false, detail: inertAfterLegacyCloseError };

    const legacyOverNativeError = await page.evaluate(async (modalUrl: string) => {
      const modal = (await import(modalUrl)) as ModalRuntime;
      modal.openConfirmDialog({
        title: 'Replaced by legacy',
        message: 'Should close when legacy overlay opens.',
      });
      const legacy = modal.createModalOverlay();
      const legacyBtn = document.createElement('button');
      legacyBtn.type = 'button';
      legacyBtn.textContent = 'Legacy interactive';
      let clicked = false;
      legacyBtn.addEventListener('click', () => { clicked = true; });
      legacy.dialog.appendChild(legacyBtn);
      legacyBtn.focus();
      legacyBtn.click();
      const focused = document.activeElement === legacyBtn;
      const nativeRemaining = document.querySelectorAll('dialog.dialog[open]').length;
      legacy.close();
      if (nativeRemaining !== 0) return `expected 0 open native dialogs after legacy overlay opened, got ${nativeRemaining}`;
      if (!focused || !clicked) return `legacy overlay button not interactive (focused=${focused}, clicked=${clicked})`;
      return null;
    }, MODAL_MODULE_URL);
    if (legacyOverNativeError) return { ok: false, detail: legacyOverNativeError };

    await page.evaluate(async ({ modalUrl, diffPanelUrl }: { modalUrl: string; diffPanelUrl: string }) => {
      const [modal, diffPanelModule] = await Promise.all([
        import(modalUrl) as Promise<ModalRuntime>,
        import(diffPanelUrl) as Promise<{ createDiffPanel: () => { element: HTMLElement; open: (file: { path: string; added: number; removed: number; patch: string }) => void; close: () => void } }>,
      ]);
      const diffPanel = diffPanelModule.createDiffPanel();
      document.body.appendChild(diffPanel.element);
      (window as ProbeWindow).__diffPanelProbe = diffPanel;
      diffPanel.open({ path: 'example.ts', added: 1, removed: 0, patch: '@@ -1 +1 @@\n-old\n+new\n' });
      const legacy = modal.createModalOverlay();
      const legacyBtn = document.createElement('button');
      legacyBtn.type = 'button';
      legacyBtn.textContent = 'Legacy over diff panel';
      legacy.dialog.appendChild(legacyBtn);
      legacyBtn.focus();
    }, { modalUrl: MODAL_MODULE_URL, diffPanelUrl: DIFF_PANEL_MODULE_URL });

    await page.keyboard.press('Escape');
    const diffPanelOverLegacyError = await page.evaluate(async (modalUrl: string) => {
      const modal = (await import(modalUrl)) as ModalRuntime;
      const diffPanel = (window as ProbeWindow).__diffPanelProbe;
      if (!diffPanel) return 'diff panel probe missing';
      if (diffPanel.element.hidden) return 'Escape inside a legacy modal closed the studio diff panel';
      if (modal.isModalOpen()) return 'Escape did not close the legacy modal over the studio diff panel';
      modal.openConfirmDialog({
        title: 'Confirm over diff panel',
        message: 'Escape should close only this dialog.',
      });
      return null;
    }, MODAL_MODULE_URL);
    if (diffPanelOverLegacyError) return { ok: false, detail: diffPanelOverLegacyError };

    await dialog.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });

    const diffPanelAfterNativeError = await page.evaluate(() => {
      const diffPanel = (window as ProbeWindow).__diffPanelProbe;
      if (!diffPanel) return 'diff panel probe missing';
      if (diffPanel.element.hidden) return 'Escape inside a native confirm dialog closed the studio diff panel';
      return null;
    });
    if (diffPanelAfterNativeError) return { ok: false, detail: diffPanelAfterNativeError };

    await page.keyboard.press('Escape');
    const diffPanelCloseError = await page.evaluate(() => {
      const diffPanel = (window as ProbeWindow).__diffPanelProbe;
      if (!diffPanel) return 'diff panel probe missing';
      const stayedOpen = !diffPanel.element.hidden;
      diffPanel.close();
      diffPanel.element.remove();
      delete (window as ProbeWindow).__diffPanelProbe;
      return stayedOpen ? 'Escape with no modal open did not close the studio diff panel' : null;
    });
    if (diffPanelCloseError) return { ok: false, detail: diffPanelCloseError };

    return { ok: true, detail: 'native dialog confirm options, keyboard navigation, backdrop, drag-out, stacking, Escape isolation, studio diff panel guard, and focus return passed' };
  } finally {
    await cleanupProbe();
  }
}
