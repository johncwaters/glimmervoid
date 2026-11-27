import crypto from 'node:crypto';
import type { Page } from 'playwright-core';

const PHONE_MORE_SELECTOR = 'button.phone-nav-item[aria-expanded]';
const PHONE_SETTINGS_MENU_SELECTOR = 'button.phone-nav-menu-item[data-screen="settings"]';
const DESKTOP_SETTINGS_TAB_SELECTOR = '#header-tabs button';
const SETTINGS_NAV_ITEM_SELECTOR = 'button.settings-view-nav-item';

export interface HooksCheckResult {
  ok: boolean;
  detail: string;
}

async function openHooksPage(page: Page): Promise<void> {
  const layout = await page.evaluate(() => document.documentElement.dataset.layout ?? 'desktop');
  if (layout === 'phone') {
    await page.locator(PHONE_MORE_SELECTOR).first().click();
    await page.locator(PHONE_SETTINGS_MENU_SELECTOR).first().click();
  }
  if (layout !== 'phone') {
    await page.locator(DESKTOP_SETTINGS_TAB_SELECTOR, { hasText: /^Settings$/ }).first().click();
  }
  const hooksNav = page.locator(SETTINGS_NAV_ITEM_SELECTOR, { hasText: /^Hooks$/ }).first();
  await hooksNav.waitFor({ state: 'visible', timeout: 10000 });
  await hooksNav.click();
  await page.locator('.hooks-panel [data-action="new-hook"]').waitFor({ state: 'visible', timeout: 10000 });
}

async function headerErrorText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const notice = document.getElementById('header-error-notice');
    if (!notice || notice.hidden) return null;
    return notice.textContent?.trim() || 'visible header error';
  });
}

export async function verifyHooks(page: Page): Promise<HooksCheckResult> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const createdName = `Harness lint hook ${suffix}`;
  const editedName = `Harness lint hook edited ${suffix}`;
  try {
    await openHooksPage(page);

    await page.locator('.hooks-panel [data-action="new-hook"]').click();
    const editor = page.locator('.hooks-editor');
    await editor.waitFor({ state: 'visible', timeout: 10000 });

    await editor.locator('input[placeholder="Lint after edits"]').fill(createdName);
    await editor.locator('textarea.hooks-command').fill('echo harness-ok');
    await editor.locator('button[data-action="save-hook"]').click();

    await editor.waitFor({ state: 'detached', timeout: 10000 });
    const createdRow = page.locator(`article.hooks-row[aria-label="${createdName}"]`);
    await createdRow.waitFor({ state: 'visible', timeout: 10000 });

    const toggleInput = createdRow.locator(`input[type="checkbox"][aria-label="${createdName} enabled"]`);
    await toggleInput.uncheck();
    const offRowEditButton = page.locator(`article.hooks-row[aria-label="${createdName}"][data-state="off"] button[data-action="edit-hook"]:not([disabled])`);
    await offRowEditButton.waitFor({ state: 'visible', timeout: 10000 });
    const toggleError = await headerErrorText(page);
    if (toggleError) return { ok: false, detail: `unexpected error after toggle: ${toggleError}` };

    await offRowEditButton.click();
    await editor.waitFor({ state: 'visible', timeout: 10000 });
    await editor.locator('input[placeholder="Lint after edits"]').fill(editedName);
    await editor.locator('button[data-action="save-hook"]').click();

    await editor.waitFor({ state: 'detached', timeout: 10000 });
    const editedRow = page.locator(`article.hooks-row[aria-label="${editedName}"]`);
    await editedRow.waitFor({ state: 'visible', timeout: 10000 });

    await editedRow.locator('button[data-action="delete-hook"]').click();
    const confirmButton = page.locator('dialog.dialog [data-action="confirm-dialog"]');
    await confirmButton.waitFor({ state: 'visible', timeout: 10000 });
    await confirmButton.click();

    await editedRow.waitFor({ state: 'detached', timeout: 10000 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await openHooksPage(page);
    const deleteError = await headerErrorText(page);
    if (deleteError) return { ok: false, detail: `unexpected error after delete: ${deleteError}` };
    const remainingCount = await page.locator(`article.hooks-row[aria-label="${editedName}"]`).count();
    if (remainingCount !== 0) {
      return { ok: false, detail: `deleted hook "${editedName}" reappeared after reload` };
    }

    return {
      ok: true,
      detail: 'hooks page loaded, created, toggled, edited, and deleted a hook with server persistence verified across reload',
    };
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
    return { ok: false, detail: message };
  }
}
