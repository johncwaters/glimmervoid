import type { ExamplePack, PackRow } from '#shared/contracts/control/pack-messages.ts';
import { REVIEW_ACTIONS_GRANT_TEXT } from '#shared/contracts/reviews.ts';
import { DEFAULT_REPLY_TIMEOUT_MS, paintActionStatus, requestFailureText } from '../action-status.ts';
import type { ActionStatusTone } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { approvalDetails } from '../github/my-prs-panel.ts';
import { buildChip } from '../settings/settings-readouts.ts';
import { button } from '../ui/button.ts';
import { packsSnapshot, subscribePacks } from './packs-store.ts';

const PACKS_TRUST_NOTE = 'Approving a pack lets its commands run on this machine, its panels show what they read, and its MCP servers join your sessions. Panels cannot reach the network, but they are trusted not to leak what they read. Any change to a file in a pack asks again.';
const STATE_LABELS: Record<PackRow['state'], string> = { pending: 'Pending', approved: 'Approved', invalid: 'Not loaded' };

const approveStatusByFingerprint = new Map<string, { tone: ActionStatusTone; text: string }>();
const addStatusByExampleName = new Map<string, { tone: ActionStatusTone; text: string }>();
let packsContainer: HTMLElement | null = null;

async function approvePack(fingerprint: string): Promise<void> {
  approveStatusByFingerprint.set(fingerprint, { tone: 'busy', text: 'Approving' });
  repaintPacks();
  try {
    const response = await sendControlRequest('pack-approve', { fingerprint }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
    if (response.type !== 'pack-approve-result') throw new Error('Unexpected pack approval reply.');
    if (!response.ok) {
      approveStatusByFingerprint.set(fingerprint, { tone: 'error', text: response.error ?? 'Could not approve this pack.' });
      return;
    }
    approveStatusByFingerprint.delete(fingerprint);
  } catch (error) {
    approveStatusByFingerprint.set(fingerprint, { tone: 'error', text: requestFailureText(error, DEFAULT_REPLY_TIMEOUT_MS) });
  } finally {
    repaintPacks();
  }
}

async function addExamplePack(name: string): Promise<void> {
  addStatusByExampleName.set(name, { tone: 'busy', text: 'Adding' });
  repaintPacks();
  try {
    const response = await sendControlRequest('pack-add-example', { name }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
    if (response.type !== 'pack-add-example-result') throw new Error('Unexpected reply to adding an example pack.');
    if (!response.ok) {
      addStatusByExampleName.set(name, { tone: 'error', text: response.error ?? 'Could not add this pack.' });
      return;
    }
    addStatusByExampleName.delete(name);
  } catch (error) {
    addStatusByExampleName.set(name, { tone: 'error', text: requestFailureText(error, DEFAULT_REPLY_TIMEOUT_MS) });
  } finally {
    repaintPacks();
  }
}

function exampleArticle(example: ExamplePack): HTMLElement {
  const article = el('article', 'settings-view-setting settings-view-pack');
  const text = el('div', 'settings-view-setting-text');
  const heading = el('div', 'settings-view-setting-heading');
  heading.append(el('h2', 'settings-view-setting-title', example.name));
  text.append(heading, ...(example.description ? [el('p', 'settings-view-setting-description', example.description)] : []));
  const control = el('div', 'settings-view-setting-control');
  const status = addStatusByExampleName.get(example.name);
  const add = button({
    variant: 'secondary', label: 'Add', action: 'pack-add-example',
    disabled: status?.tone === 'busy',
    onClick: () => { void addExamplePack(example.name); },
  });
  const statusText = el('span', 'settings-view-pack-status');
  statusText.setAttribute('role', 'status');
  paintActionStatus(statusText, status?.tone ?? null, status?.text ?? '');
  control.append(add, statusText);
  article.append(text, control);
  return article;
}

function examplesContent(examples: readonly ExamplePack[]): HTMLElement[] {
  const addable = examples.filter((example) => !example.isAdded);
  if (addable.length === 0) return [];
  return [
    el('h2', 'settings-view-section-title', 'Example packs'),
    el('p', 'settings-view-section-description', 'Packs that ship with Glimmervoid. Add one, then approve it in its row above.'),
    ...addable.map(exampleArticle),
  ];
}

function packHeading(row: PackRow): HTMLElement {
  const heading = el('div', 'settings-view-setting-heading');
  heading.append(el('h2', 'settings-view-setting-title', row.version === null ? row.name : `${row.name} v${row.version}`), ' ', buildChip('pack-state', STATE_LABELS[row.state]));
  return heading;
}

function packLines(row: PackRow): HTMLElement[] {
  const lines = [
    ...(row.description ? [row.description] : []),
    `Folder: ${row.dir}`,
    ...row.panels.map((panel) => `Panel: ${panel.label}${panel.reads.length === 0 ? ', reads nothing from the dashboard' : `, reads ${panel.reads.join(', ')}`}${panel.acts.includes('reviews') ? `; acts as you in Reviews without asking: may ${REVIEW_ACTIONS_GRANT_TEXT}` : ''}`),
    ...row.mcpServers.flatMap((server) => [`MCP server: ${server.name} at ${server.url}, added to every session you start; with no secret the agent asks you to sign in`, ...server.notes]),
    ...(row.themes.length === 0 ? [] : [`Themes: ${row.themes.map((theme) => `${theme.label} (${theme.mode})`).join(', ')}`]),
    ...(row.files.length === 0 ? [] : [`Files: ${row.files.join(', ')}`]),
    ...(row.needs.length === 0 ? [] : [`Needs: ${row.needs.join(', ')}`]),
    ...(row.missingRequires.length === 0 ? [] : [`Missing here: ${row.missingRequires.join(', ')}; the pack stays off until this machine has them`]),
  ];
  return [
    ...lines.map((line) => el('p', 'settings-view-setting-description', line)),
    ...row.errors.map((error) => el('p', 'settings-view-warning', error)),
    ...(row.prFlows ? approvalDetails(row.prFlows) : []),
  ];
}

function packControl(row: PackRow): HTMLElement {
  const control = el('div', 'settings-view-setting-control');
  const fingerprint = row.fingerprint;
  if (fingerprint === null) return control;
  const status = approveStatusByFingerprint.get(fingerprint);
  const approve = button({
    variant: 'secondary', label: 'Approve', action: 'pack-approve',
    disabled: row.state !== 'pending' || status?.tone === 'busy',
    onClick: () => { void approvePack(fingerprint); },
  });
  const statusText = el('span', 'settings-view-pack-status');
  statusText.setAttribute('role', 'status');
  paintActionStatus(statusText, status?.tone ?? null, status?.text ?? '');
  control.append(approve, statusText);
  return control;
}

function packArticle(row: PackRow): HTMLElement {
  const article = el('article', 'settings-view-setting settings-view-pack');
  article.dataset.packState = row.state;
  const text = el('div', 'settings-view-setting-text');
  text.append(packHeading(row), ...packLines(row));
  article.append(text, packControl(row));
  return article;
}

function packsContent(): HTMLElement[] {
  const status = packsSnapshot();
  const intro = el('p', 'settings-view-section-description', PACKS_TRUST_NOTE);
  if (!status) return [intro, el('p', 'settings-view-setting-description', 'Waiting for the server to list packs.')];
  const warnings = status.warnings.map((warning) => el('p', 'settings-view-warning', warning));
  const examples = examplesContent(status.examples);
  if (status.packs.length === 0) return [intro, ...warnings, el('p', 'settings-view-setting-description', 'No packs yet. Add an example pack, copy a pack folder into ~/.glimmervoid/packs/, or list its path in packs in config.json.'), ...examples];
  return [intro, ...warnings, ...status.packs.map(packArticle), ...examples];
}

function repaintPacks(): void {
  if (!packsContainer?.isConnected) return;
  packsContainer.replaceChildren(...packsContent());
}

subscribePacks(repaintPacks);

export function renderPacksPage(container: HTMLElement): void {
  packsContainer = el('div', 'settings-view-stack');
  container.appendChild(packsContainer);
  repaintPacks();
}
