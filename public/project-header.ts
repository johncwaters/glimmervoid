import { el } from './dom-helpers.ts';

interface ProjectCoherencePainter {
  build: () => HTMLElement;
  paint: (slot: HTMLElement, projectPath: string) => void;
}

let projectCoherencePainter: ProjectCoherencePainter | null = null;

export function setProjectHeaderCoherencePainter(painter: ProjectCoherencePainter) {
  projectCoherencePainter = painter;
}

export function paintProjectHeaderCoherence(header: HTMLElement, projectPath: string) {
  if (!projectCoherencePainter) return;
  let slot = header.querySelector<HTMLElement>('.project-coherence-slot');
  if (!slot) {
    slot = el('span', 'project-coherence-slot');
    slot.append(projectCoherencePainter.build());
    header.firstElementChild?.after(slot);
  }
  projectCoherencePainter.paint(slot, projectPath);
  slot.hidden = slot.firstElementChild instanceof HTMLElement && slot.firstElementChild.hidden;
}
