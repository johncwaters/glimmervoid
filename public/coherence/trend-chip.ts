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

export function buildProjectCoherenceChip(projectId?: string): HTMLElement {
  const chip = el('div', 'coherence-trend-chip');
  const button = el('button', 'coherence-journal-button', 'Coherence');
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.addEventListener('click', () => {
    if (chip.dataset.projectId) openCoherenceTrendPanel(chip.dataset.projectId);
  });
  chip.append(button, el('span', 'coherence-trend-direction'));
  paintProjectCoherenceChip(chip, projectId);
  return chip;
}

function paintProjectCoherenceChip(chip: HTMLElement, projectId?: string) {
  const reading = projectId ? trendsByProjectId.get(projectId) : undefined;
  chip.hidden = !reading;
  chip.dataset.projectId = projectId ?? '';
  const direction = chip.querySelector('.coherence-trend-direction');
  if (direction) direction.textContent = reading ? coherenceTrendDirectionLabel(reading.trend) : '';
}

export function paintProjectHeaderCoherenceChip(slot: HTMLElement, projectPath: string) {
  const projectId = [...pathsByProjectId].find(([projectId, path]) => path === projectPath && trendsByProjectId.has(projectId))?.[0];
  const chip = slot.querySelector<HTMLElement>('.coherence-trend-chip');
  if (chip) paintProjectCoherenceChip(chip, projectId);
}

export function findCoherenceTrendProjectId(projectPath: string): string | undefined {
  return [...pathsByProjectId].find(([, path]) => path === projectPath)?.[0];
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
