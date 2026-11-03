export function createPressable(className: string, text?: string): HTMLButtonElement {
  const pressable = document.createElement('button');
  pressable.type = 'button';
  pressable.className = className;
  if (text !== undefined) pressable.textContent = text;
  return pressable;
}
