import { el } from '../dom-helpers.ts';
import type { ChangeMapRepoView, ChangeMapView } from './change-map-core.ts';

function clickableFileRow(path: string, openPath: string, className: string, onOpenFile: (path: string) => void) {
  const row = el('button', className);
  row.type = 'button';
  row.title = `Open ${path} in the diff`;
  row.addEventListener('click', () => onOpenFile(openPath));
  return row;
}

function renderRepo(repo: ChangeMapRepoView, onOpenFile: (path: string) => void) {
  const section = el('section', 'review-map-repo');
  const header = el('div', 'review-map-repo-head');
  header.append(el('strong', 'review-map-repo-name', repo.header.name));
  header.append(el('span', 'review-map-count', repo.header.fileCount === 1 ? '1 file' : `${repo.header.fileCount} files`));
  section.append(header);
  const summary = el('div', 'review-map-summary');
  summary.append(el('span', '', `${repo.header.committedCount} committed`));
  summary.append(el('span', '', `${repo.header.uncommittedCount} uncommitted`));
  summary.append(el('span', '', `Base: ${repo.header.base ? repo.header.base.slice(0, 8) : 'unknown'}`));
  section.append(summary);
  if (repo.error) section.append(el('p', 'review-map-error', repo.error));
  if (repo.subsystems.length > 0) {
    const subsystems = el('div', 'review-map-subsystems');
    for (const subsystem of repo.subsystems) subsystems.append(el('span', 'review-map-chip', `${subsystem.title} (${subsystem.fileCount})`));
    section.append(subsystems);
  }
  if (repo.warnings.length > 0) {
    section.append(el('h3', 'review-map-label', 'Signals'));
    const warnings = el('div', 'review-map-warnings');
    for (const warning of repo.warnings) {
      const row = clickableFileRow(warning.path, warning.openPath, 'review-map-warning', onOpenFile);
      row.dataset.severity = String(warning.severity);
      row.dataset.kind = warning.kind;
      row.append(el('span', 'review-map-warning-headline', warning.headline));
      row.append(el('span', 'review-map-detail', warning.detail));
      warnings.append(row);
    }
    section.append(warnings);
  }
  if (repo.files.length > 0) {
    section.append(el('h3', 'review-map-label', 'Files'));
    const files = el('div', 'review-map-files');
    for (const file of repo.files) {
      const row = clickableFileRow(file.path, file.openPath, 'review-map-file', onOpenFile);
      row.dataset.status = file.status;
      row.append(el('span', 'review-map-file-path', file.path));
      row.append(el('span', 'review-map-file-meta', `${file.status} · ${file.isCommitted ? 'committed' : 'uncommitted'} · ${file.dependentCount} dependents · ${file.testCount} tests`));
      files.append(row);
    }
    section.append(files);
  }
  return section;
}

export function renderChangeMapView(view: ChangeMapView, onOpenFile: (path: string) => void): HTMLElement {
  const root = el('div', 'review-map');
  if (view.error) root.append(el('p', 'review-map-error', view.error));
  if (view.emptyState) root.append(el('div', 'review-nochanges', view.emptyState));
  if (view.narrative.status) root.append(el('p', 'review-map-narrative-status', view.narrative.status));
  if (view.narrative.claims.length > 0) {
    const narrative = el('section', 'review-map-narrative');
    narrative.append(el('h3', 'review-map-label', 'Narrative'));
    for (const claim of view.narrative.claims) {
      const paragraph = el('p', 'review-map-claim', claim.text);
      paragraph.dataset.factIds = claim.factIds.join(' ');
      narrative.append(paragraph);
    }
    root.append(narrative);
  }
  for (const repo of view.repos) root.append(renderRepo(repo, onOpenFile));
  return root;
}
