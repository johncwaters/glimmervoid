import { iconPressableLabel, pressableAttributes } from './pressable-core.ts';

export function createPressable(className: string, text?: string): HTMLButtonElement {
  const attributes = pressableAttributes(className, text);
  const pressable = document.createElement('button');
  pressable.type = attributes.type;
  pressable.className = attributes.className;
  if (attributes.text !== undefined) pressable.textContent = attributes.text;
  return pressable;
}

export function labelIconPressable(pressable: HTMLButtonElement, name: string, shortcutKey?: string): void {
  const label = iconPressableLabel(name, shortcutKey);
  pressable.setAttribute('aria-label', label.ariaLabel);
  pressable.title = shortcutKey ? label.title : label.ariaLabel;
}
