export function createPrScopeTabs(selectedMode: 'team' | 'mine', onSelectMode: (mode: 'team' | 'mine', isKeyboard: boolean) => void): HTMLElement {
  const tabs = document.createElement('div');
  tabs.className = 'pr-scope-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Reviews scope');
  const modes = ['team', 'mine'] as const;
  for (const mode of modes) {
    const tab = document.createElement('button');
    tab.className = 'pr-scope-tab';
    tab.type = 'button';
    tab.dataset.scope = mode;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(mode === selectedMode));
    tab.tabIndex = mode === selectedMode ? 0 : -1;
    tab.textContent = mode === 'team' ? 'Team' : 'Mine';
    if (mode === 'team') {
      const activity = document.createElement('span');
      activity.className = 'tab-activity';
      activity.setAttribute('aria-hidden', 'true');
      tab.append(activity);
    }
    tab.addEventListener('click', () => onSelectMode(mode, false));
    tab.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        onSelectMode(modes[(modes.indexOf(mode) + modes.length - 1) % modes.length], true);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        onSelectMode(modes[(modes.indexOf(mode) + 1) % modes.length], true);
      }
    });
    tabs.append(tab);
  }
  return tabs;
}
