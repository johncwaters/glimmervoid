import type { CustomAgentSummaryRow } from '#shared/contracts/control-messages.ts';
import { TelegramDeliveryStatus } from '#shared/contracts/control-messages.ts';
import { createActionStatus, DEFAULT_REPLY_TIMEOUT_MS, requestFailureText, requestWithStatus } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { button } from '../ui/button.ts';
import { tag } from '../ui/tag.ts';
import { disclosure } from '../ui/disclosure.ts';
import { checkbox } from '../ui/checkbox.ts';
import { createNotificationPermissionControl } from '../notifications.ts';
import { openConfirmDialog } from '../session-card/modal.ts';
import type { SettingsSetting } from '#shared/settings/registry.ts';
import { secretEnvironmentSource, workflowRuleSummaryLines, workflowRuleToggleRows } from './settings-view-core.ts';
import type { WorkflowRuleToggleRow } from './settings-view-core.ts';
import { usageStatusLines } from '../usage/usage-store.ts';
import { applySettingsBroadcast, mergeSettingsPayload } from './settings-store.ts';
import { openRemoteSetupDialog } from '../dialogs.ts';
import { buildAgentAccountsBlock, buildLaneAccountsBlock } from './settings-accounts.ts';
import { buildVaultConnectionSlot } from '../secrets/secrets-settings.ts';
import { panelRefresher, setSettingsPayload, settingsPayload, websiteUrl } from './settings-panel-state.ts';
import { buildUpdateStatusBlock } from './settings-update-status.ts';
import { confirmServerRestart, confirmServerShutdown, trackShutdownButton } from '../server-power.ts';
import { clock } from '#shared/clock.ts';

const SAVED_STATUS_MS = 2200;
const TELEMETRY_DELETION_TIMEOUT_MS = 15000;
const pendingWorkflowRuleIds = new Set<string>();

type WorkflowRuleFeedback = { tone: 'ok' | 'error'; text: string };

const workflowRuleFeedbackById = new Map<string, WorkflowRuleFeedback>();

function externalLink(label: string, href: string) {
  const link = el('a', 'settings-about-link', label);
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener';
  return link;
}

function toggleStateText(isOn: boolean) {
  return isOn ? 'On' : 'Off';
}

function resolvabilityLabel(resolvable: boolean | null): string {
  if (resolvable === null) return 'not probed yet';
  if (resolvable) return 'resolved';
  return 'not found on PATH';
}

function customAgentLines(): string[] {
  const rows: CustomAgentSummaryRow[] = Array.isArray(settingsPayload.customAgents) ? settingsPayload.customAgents : [];
  if (rows.length === 0) return ['None declared. Add customAgents to config.json.'];
  return rows.map((row) => {
    const invocation = row.args.length > 0 ? `${row.command} ${row.args.join(' ')}` : row.command;
    const status = row.isShadowedByBuiltIn ? 'ignored: a built-in agent has this id, rename it' : resolvabilityLabel(row.resolvable);
    return `${row.id}  ${row.label}  ${invocation}  ${status}`;
  });
}

function buildCustomAgentsStatus() {
  const block = el('div', 'settings-view-status-block');
  block.appendChild(el('div', 'settings-section-title', 'Declared agents'));
  for (const line of customAgentLines()) block.appendChild(el('div', 'settings-readonly', line));
  return block;
}

function showWorkflowRuleSaved(ruleId: string) {
  workflowRuleFeedbackById.set(ruleId, { tone: 'ok', text: 'Saved' });
  window.setTimeout(() => {
    if (workflowRuleFeedbackById.get(ruleId)?.tone !== 'ok') return;
    workflowRuleFeedbackById.delete(ruleId);
    panelRefresher().refreshSettingsStatus();
  }, SAVED_STATUS_MS);
}

async function saveWorkflowRuleToggle(rule: WorkflowRuleToggleRow, isTurningOn: boolean) {
  pendingWorkflowRuleIds.add(rule.id);
  workflowRuleFeedbackById.delete(rule.id);
  panelRefresher().refreshSettingsStatus();
  try {
    const message = await sendControlRequest('update-settings', { settings: { workflows: { rules: [{ id: rule.id, enabled: isTurningOn }] } } }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
    pendingWorkflowRuleIds.delete(rule.id);
    if (message.type === 'settings-error') workflowRuleFeedbackById.set(rule.id, { tone: 'error', text: String(message.message) });
    if (message.type === 'settings-updated') {
      showWorkflowRuleSaved(rule.id);
      applySettingsBroadcast(message.settings);
      return;
    }
  } catch (error) {
    workflowRuleFeedbackById.set(rule.id, { tone: 'error', text: requestFailureText(error, DEFAULT_REPLY_TIMEOUT_MS) });
  }
  pendingWorkflowRuleIds.delete(rule.id);
  panelRefresher().refreshSettingsStatus();
}

function buildWorkflowRuleStatus(rule: WorkflowRuleToggleRow) {
  const status = createActionStatus('settings-workflow-rule-status');
  if (pendingWorkflowRuleIds.has(rule.id)) {
    status.show('busy', 'Saving');
    return status.element;
  }
  const feedback = workflowRuleFeedbackById.get(rule.id);
  if (feedback) status.show(feedback.tone, feedback.text);
  return status.element;
}

function buildWorkflowRuleToggle(rule: WorkflowRuleToggleRow) {
  const row = el('div', 'settings-view-toggle-wrap');
  const text = document.createDocumentFragment();
  text.append(el('span', 'settings-view-toggle-state', toggleStateText(rule.isEnabled)), el('span', 'settings-readonly', `${rule.name}  ${rule.summary}`));
  const toggle = checkbox({
    label: text,
    checked: rule.isEnabled,
    disabled: pendingWorkflowRuleIds.has(rule.id),
    accessibleName: `Run rule ${rule.name}`,
    onChange: (checked) => { void saveWorkflowRuleToggle(rule, checked); },
  });
  row.append(toggle.element, buildWorkflowRuleStatus(rule));
  return row;
}

function buildWorkflowsStatus() {
  const block = el('div', 'settings-view-status-block');
  block.appendChild(el('div', 'settings-section-title', 'Rules'));
  const rules = workflowRuleToggleRows(settingsPayload.workflows);
  if (rules.length > 0) {
    for (const rule of rules) block.appendChild(buildWorkflowRuleToggle(rule));
    return block;
  }
  for (const line of workflowRuleSummaryLines(settingsPayload.workflows)) block.appendChild(el('div', 'settings-readonly', line));
  return block;
}

function buildUsageStatus() {
  const block = el('div', 'settings-view-status-block');
  block.appendChild(el('div', 'settings-section-title', 'Last report'));
  for (const line of usageStatusLines()) block.appendChild(el('div', 'settings-readonly', line));
  return block;
}

function buildRemoteSetupStatus() {
  const block = el('div', 'settings-view-status-block');
  block.appendChild(button({ variant: 'secondary', label: 'Set up remote host', action: 'set-up-remote-host', onClick: openRemoteSetupDialog }));
  return block;
}

function buildServerPowerStatus() {
  const block = el('div', 'settings-view-status-block settings-server-power');
  const shutdownButton = button({ variant: 'danger', label: 'Shut down', action: 'shutdown-server', onClick: confirmServerShutdown });
  trackShutdownButton(shutdownButton);
  block.append(button({ variant: 'secondary', label: 'Restart server', action: 'restart-server', onClick: confirmServerRestart }), shutdownButton);
  return block;
}

function renderReadout(setting: SettingsSetting) {
  if (setting.status === 'server-power') return buildServerPowerStatus();
  if (setting.status === 'agent-accounts') return buildAgentAccountsBlock();
  if (setting.status === 'lane-accounts') return buildLaneAccountsBlock();
  if (setting.status === 'remote-setup') return buildRemoteSetupStatus();
  if (setting.status === 'update-actions') return buildUpdateStatusBlock();
  if (setting.status === 'custom-agents') return buildCustomAgentsStatus();
  if (setting.status === 'workflows') return buildWorkflowsStatus();
  return el('div', 'settings-readonly', 'Not available');
}

function statusText(setting: SettingsSetting) {
  const environmentSource = secretEnvironmentSource(setting, settingsPayload);
  if (environmentSource) return `Supplied by ${environmentSource}. Change the server environment and restart to replace this credential.`;
  return '';
}

function buildStatusSlot(setting: SettingsSetting) {
  if (setting.control === 'readonly') return null;
  if (setting.status === 'usage-last-report') {
    const block = buildUsageStatus();
    block.classList.add('settings-view-status-slot');
    return block;
  }
  if (setting.id === 'desktop-notifications') return buildNotificationPermissionSlot(setting);
  if (setting.id === 'telemetry-enabled') return buildTelemetryDataSlot();
  if (setting.status === 'telegram-delivery') return buildTelegramDeliverySlot();
  if (setting.status === 'vault-connection') return buildVaultConnectionSlot(setting);
  const status = statusText(setting);
  if (!status) return null;
  return el('div', 'settings-view-warning settings-view-status-slot', status);
}

function telegramDeliveryLines(): string[] {
  const parsedDelivery = TelegramDeliveryStatus.safeParse(settingsPayload.telegramDelivery);
  if (!parsedDelivery.success) return [];
  const { setupWarning, lastFailure } = parsedDelivery.data;
  const lines = setupWarning ? [setupWarning] : [];
  if (lastFailure) lines.push(`The last Telegram send failed at ${clock.format(lastFailure.failedAt, 'date-time')}: ${lastFailure.message}`);
  return lines;
}

function renderTelegramDeliveryLines(container: HTMLElement) {
  container.replaceChildren(...telegramDeliveryLines().map((line) => el('p', 'settings-view-warning', line)));
}

function buildTelegramDeliverySlot() {
  const slot = el('div', 'settings-view-status-slot settings-telegram-delivery');
  const deliveryLines = el('div', 'settings-telegram-delivery-lines');
  renderTelegramDeliveryLines(deliveryLines);
  const testButton = button({ variant: 'secondary', label: 'Send test message', action: 'send-telegram-test' });
  const testStatus = createActionStatus('settings-telegram-test-status');
  testButton.addEventListener('click', async () => {
    testButton.disabled = true;
    const reply = await requestWithStatus('telegram-test', {}, testStatus, { busyText: 'Sending a test message to Telegram.' });
    testButton.disabled = false;
    if (reply?.type !== 'telegram-test-result') return;
    setSettingsPayload(mergeSettingsPayload({ telegramDelivery: reply.telegramDelivery }));
    renderTelegramDeliveryLines(deliveryLines);
    if (reply.ok) {
      testStatus.show('ok', 'Sent. Check the Telegram chat for the test message.');
      return;
    }
    testStatus.show('error', `Not sent: ${reply.error ?? 'Telegram refused the message.'}`);
  });
  const testRow = el('div', 'settings-telegram-test');
  testRow.append(testButton, testStatus.element);
  slot.append(deliveryLines, testRow);
  return slot;
}

async function requestTelemetryDeletion() {
  telemetryDeletionButton.disabled = true;
  const reply = await requestWithStatus('request-telemetry-deletion', {}, telemetryDeletionStatus, {
    busyText: 'Sending the deletion request.', timeoutMs: TELEMETRY_DELETION_TIMEOUT_MS,
  });
  telemetryDeletionButton.disabled = false;
  if (reply?.type !== 'telemetry-deletion-result') return;
  if (reply.ok) {
    telemetryDeletionStatus.show('ok', 'Deletion requested. New usage starts under a new id.');
    return;
  }
  telemetryDeletionStatus.show('error', 'Not sent: PostHog did not take the request. Try again later.');
}

const telemetryDeletionButton = button({
  variant: 'danger',
  label: 'Delete my data',
  action: 'delete-telemetry-data',
  onClick: () => openConfirmDialog({
    title: 'Delete your usage data?',
    message: 'We delete everything collected under this install. New usage starts under a new id.',
    confirmLabel: 'Delete my data',
    danger: true,
    onConfirm: () => { void requestTelemetryDeletion(); },
  }),
});

const telemetryDeletionStatus = createActionStatus('settings-telemetry-deletion-status');

const TELEMETRY_SENT_DETAIL = [
  'Sent: version, platform, app starts, daily activity, session starts and ends with agent kind, exit kind and duration, errors as their type, error code and scrubbed stack frames, and per session token counts, models and estimated costs from the usage scan.',
  'Never sent: prompts, project information, error messages from Glimmervoid or an agent, notice text, paths on your machine, repository or branch names, objectives, terminal output, account ids or hashes of them, emails, names, or anything read from another tool\'s login.',
  'Used only to improve Glimmervoid: never sold, never used for marketing or sales.',
  'Delete my data asks for everything sent under this install to be erased and starts a new install id.',
];

function buildTelemetryDataSlot() {
  const slot = el('div', 'settings-view-status-slot settings-telemetry-data');
  const sentDetail = disclosure({
    summary: 'What is sent',
    body: () => TELEMETRY_SENT_DETAIL.map((line) => el('p', 'settings-view-setting-description', line)),
  });
  sentDetail.element.classList.add('settings-telemetry-sent');
  const deletionLine = el('div', 'settings-telegram-test');
  deletionLine.append(telemetryDeletionButton, telemetryDeletionStatus.element);
  slot.append(sentDetail.element, externalLink('Privacy details', websiteUrl('/privacy')), deletionLine);
  return slot;
}

function buildNotificationPermissionSlot(setting: SettingsSetting) {
  const permissionControl = createNotificationPermissionControl(() => panelRefresher().refreshRow(setting, { force: true }));
  if (permissionControl.element.hidden) return null;
  permissionControl.element.classList.add('settings-view-status-slot');
  return permissionControl.element;
}

function buildExperimentalTag() {
  const element = tag({ text: 'Experimental', tone: 'warning' });
  element.classList.add('settings-view-experimental-tag');
  return element;
}

export { SAVED_STATUS_MS, buildExperimentalTag, buildStatusSlot, externalLink, renderReadout };
