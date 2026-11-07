import { createActionStatus, requestFailureText, DEFAULT_REPLY_TIMEOUT_MS } from '../action-status.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { addSessionRefusalText, openAddSessionDialog, revealAddedSession } from '../session-actions.ts';
import { suggestSessionName } from '../session-card/naming.ts';
import { DEFAULT_AGENT_ID } from '../session-card/agent-core.ts';
import { button } from '../ui/button.ts';
import { createPressable } from '../ui/pressable.ts';
import { FIRST_TASK_PROMPT, decideStartAgents, decideVisibleProjects } from './first-run-checklist-core.ts';
import type { StartProject } from './first-run-checklist-core.ts';

type StartFormHandlers = { onAction: (action: 'start-session' | 'open-advanced') => void };

function labelledField(labelText: string, controlId: string, ...controls: HTMLElement[]): HTMLElement {
  const field = el('div', 'first-run-start-field');
  const label = el('label', 'first-run-eyebrow', labelText);
  label.htmlFor = controlId;
  field.append(label, ...controls);
  return field;
}

function pathText(path: string): HTMLElement {
  const pathLine = el('span', 'first-run-start-project-path');
  pathLine.append(el('bdi', null, path));
  return pathLine;
}

export function createStartForm({ onAction }: StartFormHandlers) {
  let projects: StartProject[] = [];
  let selectedPath: string | null = null;
  let selectedAgentId = DEFAULT_AGENT_ID;
  let isStarting = false;

  const filterInput = el('input', 'first-run-start-filter');
  filterInput.id = 'first-run-start-filter';
  filterInput.type = 'search';
  filterInput.placeholder = 'Filter';
  filterInput.autocomplete = 'off';
  const projectList = el('ul', 'first-run-start-projects');
  projectList.setAttribute('role', 'listbox');
  projectList.setAttribute('aria-label', 'Project');
  const agentChoices = el('div', 'first-run-start-agents');
  agentChoices.id = 'first-run-start-agents';
  agentChoices.setAttribute('role', 'group');
  const taskInput = el('textarea', 'first-run-start-task');
  taskInput.id = 'first-run-start-task';
  taskInput.value = FIRST_TASK_PROMPT;
  taskInput.maxLength = 4000;
  const startButton = button({ variant: 'primary', label: 'Start session' });
  const advancedButton = button({ variant: 'quiet', label: 'Advanced' });
  const startStatus = createActionStatus('first-run-start-status');
  const footer = el('div', 'first-run-start-foot');
  footer.append(startButton, startStatus.element, advancedButton);

  const element = el('div', 'first-run-start');
  element.append(
    labelledField('Project', 'first-run-start-filter', filterInput, projectList),
    labelledField('Agent', 'first-run-start-agents', agentChoices),
    labelledField('First task', 'first-run-start-task', taskInput),
    footer,
  );

  function renderProjects() {
    const decision = decideVisibleProjects(projects, filterInput.value, selectedPath);
    selectedPath = decision.selectedPath;
    projectList.replaceChildren(...decision.visibleProjects.map((project) => {
      const row = el('li', 'first-run-start-project');
      const choice = createPressable('first-run-start-project-choice');
      choice.append(el('span', 'first-run-start-project-name', project.name), pathText(project.path));
      choice.setAttribute('role', 'option');
      choice.setAttribute('aria-selected', String(project.path === selectedPath));
      choice.addEventListener('click', () => {
        selectedPath = project.path;
        renderProjects();
      });
      row.append(choice);
      return row;
    }));
    startButton.disabled = isStarting || selectedPath === null;
  }

  function renderAgents(agentListing: unknown) {
    const decision = decideStartAgents(agentListing);
    selectedAgentId = decision.selectedId;
    agentChoices.replaceChildren(...decision.options.map((agentOption) => {
      const choice = createPressable('dialog-mode-button', agentOption.label);
      choice.setAttribute('aria-pressed', String(agentOption.id === selectedAgentId));
      choice.addEventListener('click', () => {
        selectedAgentId = agentOption.id;
        for (const other of agentChoices.children) other.setAttribute('aria-pressed', String(other === choice));
      });
      return choice;
    }));
  }

  function startSession() {
    const project = projects.find((candidate) => candidate.path === selectedPath);
    if (!project || isStarting) return;
    isStarting = true;
    startButton.disabled = true;
    startStatus.show('busy', 'Starting the session');
    onAction('start-session');
    const request: Record<string, unknown> = { name: suggestSessionName(project.name), path: project.path, prompt: taskInput.value };
    if (selectedAgentId !== DEFAULT_AGENT_ID) request.agent = selectedAgentId;
    sendControlRequest('add-session', request, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS })
      .then((reply) => {
        if (reply.type === 'add-session-result' && reply.ok) {
          startStatus.clear();
          revealAddedSession(reply.sessionId);
          return;
        }
        startStatus.show('error', addSessionRefusalText(reply));
      })
      .catch((reason: unknown) => { startStatus.show('error', `The session was not started: ${requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS)}`); })
      .finally(() => {
        isStarting = false;
        startButton.disabled = selectedPath === null;
      });
  }

  filterInput.addEventListener('input', renderProjects);
  startButton.addEventListener('click', startSession);
  advancedButton.addEventListener('click', () => {
    onAction('open-advanced');
    openAddSessionDialog();
  });

  function update({ agentListing, startableProjects }: { agentListing: unknown; startableProjects: StartProject[] }) {
    projects = startableProjects;
    renderProjects();
    renderAgents(agentListing);
  }

  return { element, update, focusTask: () => taskInput.focus() };
}
