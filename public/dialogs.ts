import agentConnectHTML from './components/agent-connect-dialog.html?raw';
import { createActionStatus, DEFAULT_REPLY_TIMEOUT_MS, requestFailureText } from './action-status.ts';
import { sendControlRequest } from './control-ws.ts';
import { ConnectableAgent } from '#shared/contracts/control-messages.ts';
import type { InstallDetail } from '#shared/contracts/control-messages.ts';
import { agentLoginOf, agentLoginSummary, applyAgentLogins, CONNECTABLE_AGENT_NAMES, onAgentLoginsChanged, refreshAgentLogins } from './agent-logins.ts';
import { el, query, queryTag, writeClipboardText } from './dom-helpers.ts';
import { createSandboxedFrame } from './sandboxed-frame.ts';
import { button } from './ui/button.ts';
import { applyDialogAria, buildDialogShell, createModalOverlay } from './session-card/modal.ts';
import { mountAddSessionPicker } from './add-session/add-session-picker.ts';
import { onSessionTick } from './session-card/session-tick.ts';
import { formatAgo } from './poll-ago.ts';
import { formatTrailOffset, trailContentKey, trailStatusText, trailTimelineRows } from './radar/radar-core.ts';
import type { InvestigationView } from './radar/radar-core.ts';

export { agentLoginOf, agentLoginSummary, onAgentLoginsChanged } from './agent-logins.ts';

export function openAgentConnectDialog(agent: ConnectableAgent) {
  const name = CONNECTABLE_AGENT_NAMES[agent];
  const { dialog, close } = createModalOverlay();
  dialog.innerHTML = agentConnectHTML;
  applyDialogAria(dialog, 'agent-connect-title');
  query(dialog, '#agent-connect-title').textContent = `Connect ${name}`;
  query(dialog, '#agent-connect-intro').textContent = `Glimmervoid signs ${name} in for its own remote sessions and keeps that login in its own folder, apart from any login you already have on this machine. The sign-in runs here and is never recorded.`;
  const stateEl = query(dialog, '#agent-connect-state');
  const stepsEl = query(dialog, '#agent-connect-steps');
  const linkEl = queryTag(dialog, '#agent-connect-link', 'a');
  const codeRowEl = query(dialog, '#agent-connect-code-row');
  const codeEl = query(dialog, '#agent-connect-code');
  const pasteLabelEl = query(dialog, '#agent-connect-paste-label');
  const pasteInput = queryTag(dialog, '#agent-connect-paste', 'input');
  const errorEl = query(dialog, '#agent-connect-error');
  const closeButton = button({ variant: 'secondary', label: 'Close' });
  const stopButton = button({ variant: 'secondary', label: 'Stop sign-in', hidden: true });
  const submitButton = button({ variant: 'primary', label: 'Submit code', hidden: true });
  const startButton = button({ variant: 'primary', label: 'Start sign-in' });
  query(dialog, '#agent-connect-actions').append(closeButton, stopButton, submitButton, startButton);

  function render() {
    if (!dialog.isConnected) {
      unsubscribe();
      return;
    }
    const login = agentLoginOf(agent);
    const isConnecting = login?.state === 'connecting';
    stateEl.textContent = agentLoginSummary(login, agent);
    startButton.hidden = isConnecting;
    stopButton.hidden = !isConnecting;
    const verificationUrl = isConnecting ? login.verificationUrl : null;
    stepsEl.hidden = verificationUrl === null;
    linkEl.href = verificationUrl ?? '';
    linkEl.textContent = verificationUrl ?? '';
    codeRowEl.hidden = !login?.userCode;
    codeEl.textContent = login?.userCode ?? '';
    const needsPastedCode = isConnecting && login.needsPastedCode;
    pasteLabelEl.hidden = !needsPastedCode;
    submitButton.hidden = !needsPastedCode;
  }

  async function send(type: string, payload: Record<string, unknown>, pressedButton: HTMLButtonElement) {
    pressedButton.disabled = true;
    errorEl.textContent = '';
    try {
      const reply = await sendControlRequest(type, { agent, ...payload }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
      if (reply.type !== 'agent-logins') return;
      applyAgentLogins(reply.logins);
      if (reply.error) errorEl.textContent = reply.error;
    } catch (reason) {
      errorEl.textContent = `The server did not answer (${requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS)}).`;
    } finally {
      pressedButton.disabled = false;
    }
  }

  startButton.addEventListener('click', () => { void send('agent-connect', { action: 'start' }, startButton); });
  stopButton.addEventListener('click', () => { void send('agent-connect', { action: 'cancel' }, stopButton); });
  submitButton.addEventListener('click', () => {
    const code = pasteInput.value;
    pasteInput.value = '';
    void send('agent-connect-code', { code }, submitButton);
  });
  pasteInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submitButton.click();
  });
  closeButton.addEventListener('click', close);
  const unsubscribe = onAgentLoginsChanged(render);
  render();
  refreshAgentLogins();
}

export function openRemoteSetupDialog() {
  const { dialog, close, actions, btnCancel } = buildDialogShell({ title: 'Set up a remote host' });
  const warning = el('p', 'dialog-hint', 'The setup session uses your ssh keys. It runs commands on the remote host over ssh and asks before each one. Glimmervoid deletes its working folder when the session ends.');
  const agentLabel = el('p', 'dialog-label', 'Agent');
  const agentChoices = el('div', 'hooks-type-row');
  agentChoices.setAttribute('role', 'radiogroup');
  const status = createActionStatus();
  const startButton = button({ variant: 'primary', label: 'Start setup' });
  btnCancel.addEventListener('click', close);
  actions.append(startButton);
  dialog.append(warning, agentLabel, agentChoices, status.element, actions);
  let chosenAgent: ConnectableAgent | null = null;
  let isStarting = false;

  function renderAgentChoices() {
    if (!dialog.isConnected) {
      unsubscribe();
      return;
    }
    const signedInAgents = ConnectableAgent.options.filter((agent) => agentLoginOf(agent)?.state === 'signed-in');
    if (chosenAgent === null || !signedInAgents.includes(chosenAgent)) chosenAgent = signedInAgents[0] ?? null;
    agentChoices.replaceChildren(...signedInAgents.map((agent) => {
      const option = el('label', 'settings-view-toggle hooks-choice');
      const input = el('input', 'settings-view-checkbox');
      input.type = 'radio';
      input.name = 'remote-setup-agent';
      input.checked = agent === chosenAgent;
      input.addEventListener('change', () => { chosenAgent = agent; });
      option.append(input, el('span', null, CONNECTABLE_AGENT_NAMES[agent]));
      return option;
    }));
    if (signedInAgents.length === 0) agentChoices.append(el('span', '', 'Sign in to Claude Code or Codex on this machine first.'));
    startButton.disabled = isStarting || chosenAgent === null;
  }

  startButton.addEventListener('click', async () => {
    if (chosenAgent === null) return;
    isStarting = true;
    startButton.disabled = true;
    status.show('busy', 'Starting the setup session.');
    try {
      const reply = await sendControlRequest('start-remote-setup', { agent: chosenAgent }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
      if (reply.type === 'start-remote-setup-result' && reply.ok) {
        close();
        return;
      }
      status.show('error', reply.type === 'start-remote-setup-result' && reply.error ? reply.error : 'The setup session did not start.');
    } catch (reason) {
      status.show('error', `The server did not answer (${requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS)}).`);
    } finally {
      isStarting = false;
      renderAgentChoices();
    }
  });

  const unsubscribe = onAgentLoginsChanged(renderAgentChoices);
  renderAgentChoices();
  refreshAgentLogins();
}


export function createAddSessionDialog() {
  const { overlay, dialog, close } = createModalOverlay({ dialogClass: 'dialog add-session-dialog' });
  overlay.classList.add('add-session-overlay');
  mountAddSessionPicker(dialog, { onStarted: close, onCancel: close });
  applyDialogAria(dialog, 'add-session-title');
}

export function createRadarReportDialog({
  issueId,
  issueTitle,
  format,
  content,
  message,
  error,
}: {
  issueId: string;
  issueTitle?: string;
  format?: string;
  content?: string;
  message?: string;
  error?: string;
}) {
  const { dialog, close, actions, btnCancel: btnClose } = buildDialogShell({
    title: 'Investigation report',
    dialogClass: 'dialog dialog-report',
    cancelLabel: 'Close',
  });
  const metaEl = el('div', 'dialog-report-meta', issueTitle || issueId || '');
  let bodyEl: HTMLIFrameElement | HTMLPreElement | null = null;
  if (format === 'html' && !error && !message) {
    bodyEl = createSandboxedFrame({ source: { kind: 'srcdoc', html: content || '' }, className: 'dialog-report-frame', title: 'Investigation report', allowsScripts: false });
  }
  if (!bodyEl) {
    bodyEl = el('pre', error ? 'dialog-report-body dialog-report-error' : 'dialog-report-body', error || message || content || '');
  }
  dialog.append(metaEl, bodyEl, actions);
  btnClose.addEventListener('click', close);
  requestAnimationFrame(() => btnClose.focus());
}

const INSTALL_KIND_TEXT: Record<InstallDetail['kind'], string> = {
  'tool-missing': 'package manager not found',
  'folder-missing': 'folder no longer exists',
  failed: 'install failed',
  'timed-out': 'timed out after 10 minutes',
};

function installDetailsText(sessionName: string, installDetails: readonly InstallDetail[]): string {
  const sections = installDetails.map((detail) => [
    `Folder: ${detail.folder}`,
    `Result: ${INSTALL_KIND_TEXT[detail.kind]}`,
    `Command: ${detail.command}`,
    `PATH searched: ${detail.searchedPath || '(empty)'}`,
    'Last output:',
    ...(detail.outputTail.length ? detail.outputTail.map((line) => `  ${line}`) : ['  (no output)']),
  ].join('\n'));
  return [`Session: ${sessionName}`, ...sections].join('\n\n');
}

export function openInstallDetailsDialog(sessionName: string, installDetails: readonly InstallDetail[]) {
  const { dialog, close, actions, btnCancel: btnClose } = buildDialogShell({
    title: 'Dependency install details',
    dialogClass: 'dialog dialog-report',
    cancelLabel: 'Close',
  });
  const detailsText = installDetailsText(sessionName, installDetails);
  const copyStatus = el('span', 'dialog-report-meta');
  copyStatus.setAttribute('role', 'status');
  const btnCopy = button({ variant: 'secondary', label: 'Copy' });
  btnCopy.addEventListener('click', () => {
    const copied = writeClipboardText(detailsText);
    if (!copied) {
      copyStatus.textContent = 'Copying is not available here; select the text instead.';
      return;
    }
    void copied.then(() => { copyStatus.textContent = 'Copied.'; }, () => { copyStatus.textContent = 'Could not copy; select the text instead.'; });
  });
  actions.prepend(copyStatus, btnCopy);
  dialog.append(el('pre', 'dialog-report-body', detailsText), actions);
  btnClose.addEventListener('click', close);
  requestAnimationFrame(() => btnClose.focus());
}

export interface InvestigationDialog {
  update: (view: InvestigationView) => void;
  isOpen: () => boolean;
  close: () => void;
}

export function createInvestigationDialog({ issueTitle, projectLabel, onOpenReport }: {
  issueTitle: string;
  projectLabel: string;
  onOpenReport: () => void;
}): InvestigationDialog {
  const { dialog, close, actions, btnCancel: btnClose } = buildDialogShell({
    title: 'Investigation',
    dialogClass: 'dialog dialog-report',
    cancelLabel: 'Close',
  });
  const metaEl = el('div', 'dialog-report-meta', projectLabel ? `${projectLabel}: ${issueTitle}` : issueTitle);
  const statusEl = el('p', 'dialog-trail-status');
  const summaryEl = el('p', 'dialog-trail-summary');
  const listEl = el('ol', 'dialog-trail-steps');
  const emptyEl = el('p', 'dialog-trail-empty', 'No tool calls yet; the session is reading the issue.');
  const btnReport = button({ variant: 'secondary', label: 'Open report', hidden: true });
  btnReport.addEventListener('click', () => { close(); onOpenReport(); });
  actions.prepend(btnReport);
  dialog.append(metaEl, statusEl, summaryEl, listEl, emptyEl, actions);
  btnClose.addEventListener('click', close);
  requestAnimationFrame(() => btnClose.focus());

  let current: InvestigationView | null = null;
  let renderedKey = '';

  function renderSteps(view: InvestigationView) {
    const wasAtBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 24;
    const key = trailContentKey(view);
    if (renderedKey !== key) {
      listEl.textContent = '';
      for (const row of trailTimelineRows(view.steps)) {
        const item = el('li', `dialog-trail-step dialog-trail-${row.kind}`);
        const text = row.kind === 'note' ? row.text : `${row.stepCount} ${row.stepCount === 1 ? 'step' : 'steps'}`;
        item.append(
          el('span', 'dialog-trail-at', formatTrailOffset(view.startedAt, row.at)),
          el('span', 'dialog-trail-detail', text),
        );
        listEl.append(item);
      }
      renderedKey = key;
    }
    emptyEl.hidden = view.steps.length > 0 || !view.inFlight;
    listEl.hidden = view.steps.length === 0;
    if (wasAtBottom) listEl.scrollTop = listEl.scrollHeight;
  }

  function paintStatus(view: InvestigationView) {
    statusEl.textContent = trailStatusText(view, formatAgo(view.startedAt));
  }

  function paint() {
    if (!current) return;
    paintStatus(current);
    statusEl.dataset.tone = current.inFlight ? 'live' : 'done';
    summaryEl.textContent = current.summaryLine;
    summaryEl.hidden = !current.summaryLine;
    btnReport.hidden = current.inFlight || !current.verdict;
    renderSteps(current);
  }

  const stopTicking = onSessionTick(() => {
    if (!dialog.isConnected) { stopTicking(); return; }
    if (!current?.inFlight) return;
    paintStatus(current);
  });

  return {
    update(view) {
      current = view;
      paint();
    },
    isOpen: () => dialog.isConnected,
    close: () => { stopTicking(); close(); },
  };
}
