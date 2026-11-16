import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCommandSafely } from './child-process-safe.ts';
import { glimmervoidHomeDir } from './config-store.ts';
import { appIconPath, selfLaunch } from './runtime-paths.ts';
import { planDesktopShortcut } from './core/desktop-shortcut-core.ts';
import type { DesktopShortcutPlan } from './core/desktop-shortcut-core.ts';

const SHORTCUT_COMMAND_TIMEOUT_MS = 30_000;
const SHORTCUT_COMMAND_OUTPUT_MAX_BYTES = 64 * 1024;
const OWN_BUNDLE_IDENTIFIER = '<string>dev.glimmervoid.launcher</string>';

function shortcutCommandOptions() {
  return { cwd: os.homedir(), env: process.env, timeoutMs: SHORTCUT_COMMAND_TIMEOUT_MS, maxBufferBytes: SHORTCUT_COMMAND_OUTPUT_MAX_BYTES };
}

async function linuxDesktopDir(): Promise<string> {
  const lookup = await runCommandSafely('xdg-user-dir', ['DESKTOP'], shortcutCommandOptions());
  const reportedDir = lookup.ok ? lookup.stdout.trim() : '';
  return reportedDir === '' ? path.join(os.homedir(), 'Desktop') : reportedDir;
}

async function desktopDirFor(platform: string): Promise<string> {
  if (platform === 'linux') return linuxDesktopDir();
  return path.join(os.homedir(), 'Desktop');
}

async function readAppIcon(): Promise<Uint8Array> {
  try {
    return await fsp.readFile(appIconPath);
  } catch {
    throw new Error(`The Glimmervoid app icon is missing at ${appIconPath}; reinstall Glimmervoid, or run npm run build in a source checkout.`);
  }
}

async function clearOwnPreviousShortcut(replacedPath: string): Promise<void> {
  const isPresent = await fsp.access(replacedPath).then(() => true, () => false);
  if (!isPresent) return;
  const infoPlist = await fsp.readFile(path.join(replacedPath, 'Contents', 'Info.plist'), 'utf8').catch(() => null);
  if (!infoPlist?.includes(OWN_BUNDLE_IDENTIFIER)) throw new Error(`${replacedPath} already exists and is not a Glimmervoid icon, so it was left alone. Move it, then run glimmervoid shortcut again.`);
  await fsp.rm(replacedPath, { recursive: true, force: true });
}

async function writePlannedFiles(plan: DesktopShortcutPlan): Promise<void> {
  for (const file of plan.files) {
    await fsp.mkdir(path.dirname(file.path), { recursive: true });
    await fsp.writeFile(file.path, file.contents);
    if (file.mode !== undefined) await fsp.chmod(file.path, file.mode);
  }
}

async function runFollowUpCommands(plan: DesktopShortcutPlan): Promise<string> {
  let lastOutput = '';
  for (const [command, ...commandArguments] of plan.followUpCommands) {
    const run = await runCommandSafely(command, commandArguments, shortcutCommandOptions());
    if (!run.ok && plan.shortcutPath === null) throw new Error(`Could not create the desktop shortcut: ${run.stderr.trim()}`);
    lastOutput = run.stdout.trim();
  }
  return lastOutput;
}

async function createDesktopShortcut(): Promise<string> {
  const plan = planDesktopShortcut({
    platform: process.platform,
    desktopDir: await desktopDirFor(process.platform),
    iconDir: path.join(glimmervoidHomeDir(), 'desktop'),
    launchArgv: selfLaunch('cli'),
    png: await readAppIcon(),
  });
  if (!plan) throw new Error(`Desktop icons are not supported on ${process.platform}.`);
  if (plan.replacedPath !== null) await clearOwnPreviousShortcut(plan.replacedPath);
  await writePlannedFiles(plan);
  const followUpOutput = await runFollowUpCommands(plan);
  return plan.shortcutPath ?? followUpOutput;
}

async function runShortcutCli(): Promise<number> {
  try {
    console.log(`Placed the Glimmervoid icon at ${await createDesktopShortcut()}. Double-click it to open Glimmervoid.`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export { runShortcutCli };
