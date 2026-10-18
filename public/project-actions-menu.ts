import { el } from './dom-helpers.ts';
import { buildMenuItem, focusAdjacentMenuItem, isMenuArrowKey } from './menu.ts';
import { quickAddSession } from './session-actions.ts';

export interface ProjectAction {
  label: string;
  hint: string;
  className: string;
  run: () => void;
}

interface MenuProject {
  path: string;
  label: string;
}

type ProjectActionSource = (projectPath: string) => ProjectAction | null;

const projectActionSources: ProjectActionSource[] = [];

export function addProjectActionSource(source: ProjectActionSource) {
  projectActionSources.push(source);
}

function projectActions({ path, label }: MenuProject): ProjectAction[] {
  const newSession: ProjectAction = {
    label: 'New session',
    hint: `Start a session in ${label}`,
    className: 'project-action-new-session',
    run: () => quickAddSession(path, label),
  };
  return [newSession, ...projectActionSources.map((source) => source(path)).filter((action) => action !== null)];
}

function placeUnderButton(menu: HTMLElement, button: HTMLElement) {
  const buttonBounds = button.getBoundingClientRect();
  menu.style.setProperty('--project-menu-top', `${buttonBounds.bottom + 4}px`);
  menu.style.setProperty('--project-menu-right', `${document.documentElement.clientWidth - buttonBounds.right}px`);
}

export function attachProjectActionsMenu(button: HTMLButtonElement, readProject: () => MenuProject) {
  const menu = el('div', 'popup-menu project-actions-menu');
  menu.popover = 'auto';
  menu.setAttribute('role', 'menu');
  button.popoverTargetElement = menu;
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const menuItems = () => [...menu.querySelectorAll<HTMLElement>('.popup-menu-item')];

  menu.addEventListener('beforetoggle', (event) => {
    if (event.newState !== 'open') return;
    const project = readProject();
    menu.setAttribute('aria-label', `${project.label} actions`);
    menu.replaceChildren(...projectActions(project).map((action) => {
      const item = buildMenuItem(action.label, action.hint, action.className);
      item.addEventListener('click', () => {
        menu.hidePopover();
        action.run();
      });
      return item;
    }));
    placeUnderButton(menu, button);
  });
  menu.addEventListener('toggle', (event) => {
    const isOpen = event.newState === 'open';
    button.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) return;
    if (menu.contains(document.activeElement) || document.activeElement === document.body) button.focus();
  });
  const moveMenuFocus = (event: KeyboardEvent) => {
    if (!isMenuArrowKey(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!menu.matches(':popover-open')) menu.showPopover();
    focusAdjacentMenuItem(menuItems(), event);
  };
  button.addEventListener('keydown', moveMenuFocus);
  menu.addEventListener('keydown', moveMenuFocus);
  return menu;
}
