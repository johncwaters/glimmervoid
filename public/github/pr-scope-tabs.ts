interface PrScopeTabsOptions<Scope extends string> {
  label: string;
  scopes: readonly { id: Scope; label: string }[];
  selected: Scope;
  onSelect: (scope: Scope) => void;
}

export function createPrScopeTabs<Scope extends string>({ label, scopes, selected, onSelect }: PrScopeTabsOptions<Scope>): { element: HTMLElement; select: (scope: Scope) => void } {
  const tabs = document.createElement('div');
  tabs.className = 'pr-scope-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', label);
  const buttons = scopes.map((scope) => {
    const tab = document.createElement('button');
    tab.className = 'pr-scope-tab';
    tab.type = 'button';
    tab.dataset.scope = scope.id;
    tab.setAttribute('role', 'tab');
    tab.textContent = scope.label;
    return tab;
  });
  const select = (scope: Scope): void => {
    for (const [index, tab] of buttons.entries()) {
      const isSelected = scopes[index].id === scope;
      tab.setAttribute('aria-selected', String(isSelected));
      tab.tabIndex = isSelected ? 0 : -1;
    }
  };
  const choose = (index: number, isKeyboard: boolean): void => {
    const scope = scopes[(index + scopes.length) % scopes.length];
    select(scope.id);
    onSelect(scope.id);
    if (isKeyboard) buttons[(index + scopes.length) % scopes.length].focus();
  };
  for (const [index, tab] of buttons.entries()) {
    tab.addEventListener('click', () => choose(index, false));
    tab.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        choose(index - 1, true);
        return;
      }
      if (event.key !== 'ArrowRight') return;
      event.preventDefault();
      choose(index + 1, true);
    });
  }
  tabs.append(...buttons);
  select(selected);
  return { element: tabs, select };
}
