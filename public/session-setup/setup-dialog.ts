import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import type { SessionSetup } from '#shared/contracts/session-setup.ts';
import { createRequestPanelLifecycle } from '../coherence/coherence-panel-shell.ts';
import { buildPanelSection, el } from '../dom-helpers.ts';

const setupDialogs = createRequestPanelLifecycle<{ sections: HTMLElement }>({
  requestPrefix: 'session-setup',
  dialogClass: 'dialog coherence-journal-drawer session-setup-dialog',
  titleText: 'Session setup',
  unavailableLabel: 'Session setup unavailable',
  timeoutMs: 15000,
});

function setupList(names: string[]): HTMLElement {
  const list = el('ul', 'session-setup-list');
  list.append(...names.map((name) => el('li', null, name)));
  return list;
}

function paintSetup(container: HTMLElement, setup: SessionSetup) {
  container.replaceChildren();
  function appendSection(title: string, rows: HTMLElement[]) {
    if (rows.length === 0) return;
    const section = buildPanelSection('session-setup', title);
    section.append(...rows);
    container.append(section);
  }
  appendSection('Model', setup.model ? [el('p', null, setup.model)] : []);
  appendSection('Plugins', setup.plugins.map((plugin) => {
    const entry = el('div', 'session-setup-plugin');
    entry.append(el('h3', null, plugin.name));
    if (plugin.skills.length > 0) entry.append(el('p', 'session-setup-label', 'Skills'), setupList(plugin.skills));
    if (plugin.agents.length > 0) entry.append(el('p', 'session-setup-label', 'Agents'), setupList(plugin.agents));
    return entry;
  }));
  appendSection('MCP servers', setup.mcpServers.length > 0 ? [setupList(setup.mcpServers)] : []);
  const hookRows = setup.hookEvents.map((hook) => {
    const row = el('p', 'session-setup-hook');
    row.append(el('span', null, hook.event), el('span', 'session-setup-label', `${hook.runCount} runs`));
    return row;
  });
  appendSection('Hooks', [...hookRows, ...setup.hookCommands.map((command) => el('pre', 'coherence-command', command))]);
  appendSection('Skills', setup.skills.length > 0 ? [setupList(setup.skills)] : []);
  appendSection('Agents', setup.agents.length > 0 ? [setupList(setup.agents)] : []);
}

export function openSessionSetup(sessionId: string) {
  const status = el('p', 'coherence-journal-status', 'Loading session setup');
  status.setAttribute('role', 'status');
  const sections = el('div', 'session-setup-sections');
  setupDialogs.open({
    sessionId,
    status,
    body: [status, sections],
    parts: { sections },
    buildRequest: (requestId) => ({ type: 'session-setup', id: sessionId, requestId }),
  });
}

export function applySessionSetupResponse(message: ServerMessageOf<'session-setup-response'>) {
  const dialog = setupDialogs.settleResponse(message);
  if (!dialog) return;
  if (!message.ok || !message.setup) {
    dialog.status.textContent = message.error || 'Could not read session setup';
    return;
  }
  const sections = dialog.parts.sections;
  paintSetup(sections, message.setup);
  dialog.status.textContent = sections.childElementCount > 0 ? '' : 'No session setup recorded yet';
  dialog.status.hidden = sections.childElementCount > 0;
}
