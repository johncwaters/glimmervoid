import { nextRovingIndex } from '../roving-keys-core.ts';

interface PrScopeTabsOptions<Scope extends string> {
  label: string;
  scopes: readonly { id: Scope; label: string }[];
  selected: Scope;
  onSelect: (scope: Scope) => void;
  extraClassName?: string;
  countClassPrefix?: string;
}

export function createPrScopeTabs<Scope extends string>({ label, scopes, selected, onSelect, extraClassName, countClassPrefix }: PrScopeTabsOptions<Scope>): {
  element: HTMLElement;
  select: (scope: Scope) => void;
  countElementByScope: ReadonlyMap<Scope, HTMLElement>;
} {
  const tabs = document.createElement('div');
  tabs.className = extraClassName ? `pr-scope-tabs ${extraClassName}` : 'pr-scope-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', label);
  const countElementByScope = new Map<Scope, HTMLElement>();
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
    select(scopes[index].id);
    onSelect(scopes[index].id);
    if (isKeyboard) buttons[index].focus();
  };
  for (const [index, tab] of buttons.entries()) {
    tab.addEventListener('click', () => choose(index, false));
    tab.addEventListener('keydown', (event) => {
      const nextIndex = nextRovingIndex(event.key, index, buttons.length, 'horizontal');
      if (nextIndex === null) return;
      event.preventDefault();
      choose(nextIndex, true);
    });
  }
  tabs.append(...buttons.map((tab, index) => {
    if (!countClassPrefix) return tab;
    const wrapper = document.createElement('span');
    wrapper.className = countClassPrefix;
    wrapper.setAttribute('role', 'presentation');
    const count = document.createElement('span');
    count.className = `${countClassPrefix}-count`;
    count.dataset.scopeCount = scopes[index].id;
    countElementByScope.set(scopes[index].id, count);
    wrapper.append(tab, count);
    return wrapper;
  }));
  select(selected);
  return { element: tabs, select, countElementByScope };
}
