import type { ProjectCoherenceTrend } from '#shared/contracts/coherence.ts';
import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { el } from '../dom-helpers.ts';
import { buildProjectCoherenceCheckAction } from './check-action.ts';
import { openCoherencePanelShell } from './coherence-panel-shell.ts';
import { coherenceTrendDirectionLabel, coherenceTrendPanelRows } from './trend-core.ts';

const trendsByProjectId = new Map<string, ProjectCoherenceTrend>();
const pathsByProjectId = new Map<string, string>();
let openPanel: { projectId: string; reading: HTMLElement; close: () => void } | null = null;

export function setCoherenceTrendProjects(projects: readonly { id: string; path: string; ephemeral?: boolean }[]) {
  pathsByProjectId.clear();
  for (const project of projects) noteCoherenceTrendProject(project);
}

export function noteCoherenceTrendProject(project: { id: string; path: string; ephemeral?: boolean }) {
  if (!project.ephemeral) pathsByProjectId.set(project.id, project.path);
}

export function forgetCoherenceTrendProject(projectId: string) {
  pathsByProjectId.delete(projectId);
}

export function applyProjectCoherenceTrend(message: ServerMessageOf<'project-coherence-trend'>) {
  trendsByProjectId.set(message.projectId, { latest: message.latest, trend: message.trend });
  paintOpenPanel();
}

export function applyProjectCoherenceTrendSnapshot(message: ServerMessageOf<'project-coherence-trend-snapshot'>) {
  trendsByProjectId.clear();
  for (const [projectId, trend] of Object.entries(message.projects)) trendsByProjectId.set(projectId, trend);
  paintOpenPanel();
}

export function buildProjectCoherenceChip(projectId: string): HTMLElement {
  const reading = trendsByProjectId.get(projectId);
  const chip = el('div', 'coherence-trend-chip');
  chip.hidden = !reading;
  const button = el('button', 'coherence-journal-button', 'Coherence');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.addEventListener('click', () => openCoherenceTrendPanel(projectId));
  chip.append(button, el('span', 'coherence-trend-direction', reading ? coherenceTrendDirectionLabel(reading.trend) : ''));
  return chip;
}

export function listCoherenceTrendProjects(): { projectId: string; path: string }[] {
  const projectIdsByPath = new Map<string, string>();
  for (const [projectId, path] of pathsByProjectId) {
    if (!projectIdsByPath.has(path)) projectIdsByPath.set(path, projectId);
  }
  return [...projectIdsByPath].map(([path, projectId]) => ({ projectId, path }));
}

export function hasCoherenceTrendReading(projectId: string): boolean {
  const projectPath = pathsByProjectId.get(projectId);
  return trendsByProjectId.has(projectId) || [...pathsByProjectId].some(([candidateId, path]) => path === projectPath && trendsByProjectId.has(candidateId));
}

function paintOpenPanel() {
  if (!openPanel) return;
  const reading = trendsByProjectId.get(openPanel.projectId);
  if (!reading) {
    openPanel.close();
    return;
  }
  const rows = coherenceTrendPanelRows(reading.latest, reading.trend);
  openPanel.reading.replaceChildren(...rows.map((row) => {
    const section = el('section', 'coherence-trend-reading');
    section.append(el('h4', null, row.label), el('p', null, row.text));
    if (row.configLine) section.append(el('pre', 'coherence-command', row.configLine));
    return section;
  }));
  if (rows.some((row) => row.configLine)) openPanel.reading.append(el('p', null, 'Glimmervoid never edits the repo config.'));
}

function openCoherenceTrendPanel(projectId: string) {
  if (!trendsByProjectId.has(projectId)) return;
  openPanel?.close();
  const reading = el('div', 'coherence-trend-readings');
  const checkAction = buildProjectCoherenceCheckAction(projectId);
  const shell = openCoherencePanelShell({
    dialogClass: 'dialog coherence-journal-drawer coherence-trend-panel',
    titleText: 'Coherence trend',
    titleId: 'coherence-trend-title',
    body: [checkAction.element, reading],
    onCloseRequest: () => panel.close(),
  });
  const panel = { projectId, reading, close: () => {
    if (openPanel === panel) openPanel = null;
    checkAction.dispose();
    shell.close();
  } };
  openPanel = panel;
  paintOpenPanel();
  shell.focusClose();
}
