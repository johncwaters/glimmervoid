import type { PackRow } from '#shared/contracts/control/pack-messages.ts';
import { capitalized, packGrants } from '#shared/pack-approval.ts';
import { paintActionStatus } from '../action-status.ts';
import type { ActionStatusTone } from '../action-status.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { openFirstPackPanel } from './pack-views.ts';
import { packHeading, packLines, requestPackApproval } from './packs-settings.ts';
import { packsSnapshot } from './packs-store.ts';
import './pack-approval-content.css';

type PackApprovalControls = { close: () => void; repaint: () => void };

const approvalStatusByPackName = new Map<string, { tone: ActionStatusTone; text: string }>();

function statusLine(packName: string): HTMLElement {
  const status = approvalStatusByPackName.get(packName);
  const line = el('span', 'pack-approval-status');
  line.setAttribute('role', 'status');
  paintActionStatus(line, status?.tone ?? null, status?.text ?? '');
  return line;
}

async function approve(row: PackRow, fingerprint: string, controls: PackApprovalControls): Promise<void> {
  approvalStatusByPackName.set(row.name, { tone: 'busy', text: `Approving ${row.name}` });
  controls.repaint();
  const outcome = await requestPackApproval(fingerprint);
  if (!outcome.ok) {
    approvalStatusByPackName.set(row.name, { tone: 'error', text: outcome.error });
    controls.repaint();
    return;
  }
  approvalStatusByPackName.delete(row.name);
  controls.close();
  openFirstPackPanel(row.name);
}

function approvedBody(row: PackRow): HTMLElement[] {
  const hasPanel = packsSnapshot()?.panels.some((panel) => panel.pack === row.name) ?? false;
  const footer = el('div', 'pack-approval-actions');
  if (hasPanel) footer.append(button({ variant: 'secondary', size: 'small', label: 'Open panel', onClick: () => openFirstPackPanel(row.name) }));
  return [el('p', 'pack-approval-note', `${row.name} is approved and in use.`), footer];
}

function pendingBody(row: PackRow, controls: PackApprovalControls): HTMLElement[] {
  const fingerprint = row.fingerprint;
  const isBusy = approvalStatusByPackName.get(row.name)?.tone === 'busy';
  const canApprove = fingerprint !== null && row.state === 'pending' && row.errors.length === 0 && !isBusy;
  const details = el('details', 'pack-approval-details');
  details.append(el('summary', 'pack-approval-details-summary', 'Show everything it adds'), ...packLines(row));
  const actions = el('div', 'pack-approval-actions');
  actions.append(
    button({ variant: 'secondary', size: 'small', label: 'Dismiss', disabled: isBusy, onClick: controls.close }),
    button({ variant: 'primary', size: 'small', label: 'Approve', action: 'pack-approve', disabled: !canApprove, onClick: () => { if (fingerprint !== null) void approve(row, fingerprint, controls); } }),
  );
  return [
    ...packGrants(row).map((grant) => el('p', 'pack-approval-grant', capitalized(grant))),
    ...row.errors.map((error) => el('p', 'pack-approval-error', error)),
    details,
    statusLine(row.name),
    actions,
  ];
}

export function buildPackApprovalContent(packName: string, controls: PackApprovalControls): HTMLElement {
  const content = el('div', 'pack-approval');
  content.setAttribute('role', 'group');
  content.setAttribute('aria-label', `Approve the pack ${packName}`);
  const row = packsSnapshot()?.packs.find((candidate) => candidate.name === packName);
  if (!row) {
    content.append(el('p', 'pack-approval-note', `No pack named ${packName} is loaded here.`));
    return content;
  }
  content.append(packHeading(row));
  if (row.description) content.append(el('p', 'pack-approval-description', row.description));
  content.append(...(row.state === 'approved' ? approvedBody(row) : pendingBody(row, controls)));
  return content;
}
