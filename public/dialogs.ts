import addSessionHTML from './components/add-session-dialog.html?raw';
import { sendControlMsg, sendControlRequest } from './control-ws.ts';
import type { ServerMessage } from '#shared/contracts/control-messages.ts';
import { el, query, queryTag } from './dom-helpers.ts';
import { createRepoRootsAdder } from './onboarding/repo-roots-adder.ts';
import { applyDialogAria, buildDialogShell, createModalOverlay } from './session-card/modal.ts';
import { buildRepoCheckbox } from './session-card/workspace-repos-dialog.ts';
import { DEFAULT_AGENT_ID, decideAgentAvailability, decideAgentPicker } from './session-card/agent-core.ts';
import { countSessionsByName, suggestSessionName } from './session-card/naming.ts';
import { onSessionTick } from './session-card/session-tick.ts';
import { formatAgo } from './poll-ago.ts';
import { formatTrailOffset, trailContentKey, trailStatusText } from './radar/radar-core.ts';
import type { InvestigationView } from './radar/radar-core.ts';

interface OptionSettings {
  value?: string;
  disabled?: boolean;
  selected?: boolean;
}

function option(text: string, { value, disabled = false, selected = false }: OptionSettings = {}) {
  const optionEl = el('option', null, text);
  if (value != null) optionEl.value = value;
  if (disabled) optionEl.disabled = true;
  if (selected) optionEl.selected = true;
  return optionEl;
}

function skipsPermissionsByDefault(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return false;
  return 'skipPermissionsByDefault' in settings && settings.skipPermissionsByDefault === true;
}

function addSessionRefusalText(reply: ServerMessage): string {
  if (reply.type === 'add-session-result' && reply.error) return reply.error;
  if (reply.type === 'error') return reply.message;
  return 'The session was not added.';
}

export function createAddSessionDialog() {
  const { dialog, close } = createModalOverlay();
  dialog.innerHTML = addSessionHTML;
  applyDialogAria(dialog, 'add-session-title');

  const pickerEl = queryTag(dialog, '#add-session-picker', 'select');
  const pickerLabelEl = query(dialog, '#add-session-picker-label');
  const workspaceListEl = query(dialog, '#add-session-workspace-list');
  const singleModeButton = queryTag(dialog, '#add-session-single-mode', 'button');
  const workspaceModeButton = queryTag(dialog, '#add-session-workspace-mode', 'button');
  const agentLabelEl = query(dialog, '#add-session-agent-label');
  const agentSelectEl = queryTag(dialog, '#add-session-agent', 'select');
  const repoRootsEl = query(dialog, '#add-session-repo-roots');
  const repoRootsTitleEl = query(dialog, '#add-session-repo-roots-title');
  const advancedToggle = queryTag(dialog, '#add-session-advanced-toggle', 'button');
  const advancedPanel = query(dialog, '#add-session-advanced');
  const nameInput = queryTag(dialog, '#add-session-name', 'input');
  const pathInput = queryTag(dialog, '#add-session-path', 'input');
  const pathLabelEl = query(dialog, '#add-session-path-label');
  const skipPermsCheckbox = queryTag(dialog, '#add-session-skip-perms', 'input');
  const unguardedCheckbox = queryTag(dialog, '#add-session-unguarded', 'input');
  const runInPlaceLabelEl = query(dialog, '#add-session-run-in-place-label');
  const runInPlaceCheckbox = queryTag(dialog, '#add-session-run-in-place', 'input');
  const errorEl = query(dialog, '#add-session-error');
  const btnCancel = queryTag(dialog, '#add-session-cancel', 'button');
  const btnConfirm = queryTag(dialog, '#add-session-confirm', 'button');
  let isWorkspaceMode = false;

  function setWorkspaceMode(enabled: boolean) {
    isWorkspaceMode = enabled;
    singleModeButton.setAttribute('aria-pressed', String(!enabled));
    workspaceModeButton.setAttribute('aria-pressed', String(enabled));
    pickerLabelEl.hidden = enabled;
    workspaceListEl.hidden = !enabled;
    advancedToggle.hidden = enabled;
    advancedToggle.setAttribute('aria-expanded', String(enabled));
    advancedPanel.hidden = !enabled;
    pathLabelEl.hidden = enabled;
    if (enabled) requestAnimationFrame(() => nameInput.focus());
  }
  singleModeButton.addEventListener('click', () => setWorkspaceMode(false));
  workspaceModeButton.addEventListener('click', () => setWorkspaceMode(true));

  advancedToggle.setAttribute('aria-expanded', 'false');
  advancedToggle.addEventListener('click', () => {
    const expanded = advancedPanel.hidden;
    advancedPanel.hidden = !expanded;
    advancedToggle.setAttribute('aria-expanded', String(expanded));
    if (expanded) requestAnimationFrame(() => nameInput.focus());
  });

  const repoRootsAdder = createRepoRootsAdder({ onAdded: fillProjectPicker });
  repoRootsEl.append(repoRootsAdder.element);

  function showRepoRootsAdder(message: ServerMessage) {
    const isScan = message.type === 'repo-roots-scanned';
    repoRootsTitleEl.textContent = isScan && message.directories.length > 0 ? 'No projects in your repository roots yet' : 'No repository roots yet';
    repoRootsAdder.setSuggestions(isScan ? message.suggestions ?? [] : []);
    repoRootsEl.hidden = false;
  }

  function fillProjectPicker() {
    return sendControlRequest('scan-repo-roots', { includeSuggestions: true })
      .then((message) => {
        pickerEl.textContent = '';
        workspaceListEl.textContent = '';
        repoRootsEl.hidden = true;
        pickerEl.appendChild(option('-- Select a project --', { value: '', disabled: true, selected: true }));
        let hasProjects = false;
        const directories = message.type === 'repo-roots-scanned' ? message.directories : [];
        for (const directory of directories) {
          if (directory.projects.length === 0) continue;
          const group = el('optgroup');
          group.label = directory.root;
          for (const project of directory.projects) {
            const existingCount = countSessionsByName(project.name);
            const openLabel = existingCount > 0 ? `${project.name} (${existingCount} open)` : project.name;
            const label = project.isGit === false ? `${openLabel} (not a git repo)` : openLabel;
            group.appendChild(option(label, { value: JSON.stringify({ name: project.name, path: project.path, isGit: project.isGit !== false }) }));
            workspaceListEl.appendChild(buildRepoCheckbox(project.name, project.path));
            hasProjects = true;
          }
          pickerEl.appendChild(group);
        }
        if (hasProjects) return;
        pickerEl.textContent = '';
        pickerEl.appendChild(option('No projects yet', { disabled: true, selected: true }));
        workspaceListEl.textContent = 'No projects yet.';
        showRepoRootsAdder(message);
      })
      .catch(() => {
        pickerEl.textContent = '';
        pickerEl.appendChild(option('Scan failed', { disabled: true, selected: true }));
        workspaceListEl.textContent = 'Repository scan failed.';
      });
  }
  void fillProjectPicker();

  pickerEl.addEventListener('change', () => {
    try {
      const project = JSON.parse(pickerEl.value) as { name: string; path: string; isGit: boolean };
      nameInput.value = suggestSessionName(project.name);
      pathInput.value = project.path;
      showRunInPlaceChoice(!project.isGit);
    } catch {}
  });

  let selectedAgentId = DEFAULT_AGENT_ID;
  let isSpawnBlocked = false;
  function blockSpawnWithGuidance(guidance: string) {
    isSpawnBlocked = true;
    btnConfirm.disabled = true;
    const agentGuidanceEl = el('p', 'dialog-hint dialog-hint-warning', guidance);
    agentGuidanceEl.id = 'add-session-agent-guidance';
    agentGuidanceEl.setAttribute('role', 'status');
    errorEl.before(agentGuidanceEl);
  }
  sendControlRequest('list-agents', {})
    .then((message) => {
      const availability = decideAgentAvailability(message);
      if (!availability.canSpawn) blockSpawnWithGuidance(availability.guidance);
      const decision = decideAgentPicker(message.type === 'agents-listed' ? message.agents : []);
      selectedAgentId = decision.selectedId;
      if (!decision.show) return;
      agentSelectEl.textContent = '';
      for (const agentOption of decision.options) {
        agentSelectEl.appendChild(option(agentOption.label, {
          value: agentOption.id,
          selected: agentOption.id === decision.selectedId,
        }));
      }
      agentLabelEl.hidden = false;
    })
    .catch(() => {});
  agentSelectEl.addEventListener('change', () => { selectedAgentId = agentSelectEl.value; });

  let hasOperatorChosenPermissions = false;
  skipPermsCheckbox.addEventListener('change', () => { hasOperatorChosenPermissions = true; });
  sendControlRequest('get-settings', {})
    .then((message) => {
      if (hasOperatorChosenPermissions) return;
      skipPermsCheckbox.checked = skipsPermissionsByDefault(message.settings);
    })
    .catch(() => {});

  function showRunInPlaceChoice(isShown: boolean) {
    runInPlaceLabelEl.hidden = !isShown;
    runInPlaceCheckbox.checked = false;
  }

  nameInput.addEventListener('input', () => { pickerEl.selectedIndex = 0; });
  pathInput.addEventListener('input', () => {
    pickerEl.selectedIndex = 0;
    showRunInPlaceChoice(false);
  });

  function submit() {
    if (isSpawnBlocked) return;
    const name = nameInput.value.trim();
    const projectPath = pathInput.value.trim();
    if (isWorkspaceMode) {
      const repos = [...workspaceListEl.querySelectorAll<HTMLInputElement>('input:checked')].map((checkbox) => checkbox.value);
      if (!name || repos.length < 2) {
        errorEl.textContent = 'Enter a name and select at least two repositories.';
        return;
      }
      const message: Record<string, unknown> = {
        type: 'add-session',
        name: suggestSessionName(name),
        path: repos[0],
        repos,
        dangerouslySkipPermissions: skipPermsCheckbox.checked,
        unguarded: unguardedCheckbox.checked,
      };
      if (selectedAgentId && selectedAgentId !== DEFAULT_AGENT_ID) message.agent = selectedAgentId;
      sendControlMsg(message);
      close();
      return;
    }
    if (!name || !projectPath) {
      errorEl.textContent = 'Both fields are required. Select a project or use Advanced options.';
      return;
    }
    const message: Record<string, unknown> = {
      name: suggestSessionName(name),
      path: projectPath,
      dangerouslySkipPermissions: skipPermsCheckbox.checked,
      unguarded: unguardedCheckbox.checked,
      runInPlace: runInPlaceCheckbox.checked,
    };
    if (selectedAgentId && selectedAgentId !== DEFAULT_AGENT_ID) message.agent = selectedAgentId;
    btnConfirm.disabled = true;
    errorEl.textContent = '';
    sendControlRequest('add-session', message)
      .then((reply) => {
        if (reply.type === 'add-session-result' && reply.ok) {
          close();
          return;
        }
        errorEl.textContent = addSessionRefusalText(reply);
        if (reply.type === 'add-session-result' && reply.reason === 'not-git') runInPlaceLabelEl.hidden = false;
      })
      .catch(() => { errorEl.textContent = 'The session was not added: the server did not answer.'; })
      .finally(() => { btnConfirm.disabled = isSpawnBlocked; });
  }

  btnCancel.addEventListener('click', close);
  btnConfirm.addEventListener('click', submit);
  nameInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (isWorkspaceMode) submit();
    if (!isWorkspaceMode) pathInput.focus();
  });
  pathInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  requestAnimationFrame(() => pickerEl.focus());
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
    const reportFrame = el('iframe', 'dialog-report-frame');
    reportFrame.setAttribute('sandbox', '');
    reportFrame.srcdoc = content || '';
    bodyEl = reportFrame;
  }
  if (!bodyEl) {
    bodyEl = el('pre', error ? 'dialog-report-body dialog-report-error' : 'dialog-report-body', error || message || content || '');
  }
  dialog.append(metaEl, bodyEl, actions);
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
  const btnReport = el('button', 'btn-dialog btn-dialog-cancel', 'Open report');
  btnReport.type = 'button';
  btnReport.hidden = true;
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
      for (const step of view.steps) {
        const item = el('li', 'dialog-trail-step');
        item.append(
          el('span', 'dialog-trail-at', formatTrailOffset(view.startedAt, step.at)),
          el('span', 'dialog-trail-tool', step.tool),
          el('span', 'dialog-trail-detail', step.detail),
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
