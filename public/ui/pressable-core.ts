type PressableAttributes = {
  readonly type: 'button';
  readonly className: string;
  readonly text?: string;
};

type IconPressableLabel = {
  readonly ariaLabel: string;
  readonly title: string;
};

export function pressableAttributes(className: string, text?: string): PressableAttributes {
  return {
    type: 'button',
    className,
    ...(text !== undefined ? { text } : {}),
  };
}

export function iconPressableLabel(name: string, shortcutKey?: string): IconPressableLabel {
  return {
    ariaLabel: name,
    title: shortcutKey ? `${name} (${shortcutKey})` : name,
  };
}
