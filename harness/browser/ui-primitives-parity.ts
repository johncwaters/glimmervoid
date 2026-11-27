import type { Page } from 'playwright-core';
import type { mountIsland } from '../../public/ui/island.ts';

export interface UiPrimitivesParityResult {
  ok: boolean;
  detail: string;
}

type SolidComponentFn = (props: Record<string, unknown>) => unknown;

const MODULE_URLS = {
  island: '/ui/island.ts',
  svgDom: '/svg-dom.ts',
  pressable: '/ui/pressable.ts',
  pressableSolid: '/ui/Pressable.tsx',
  button: '/ui/button.ts',
  buttonSolid: '/ui/Button.tsx',
  textInput: '/ui/text-input.ts',
  textInputSolid: '/ui/TextInput.tsx',
  field: '/ui/field.ts',
  fieldSolid: '/ui/Field.tsx',
} as const;

interface LoadedSliceAModules {
  mountIsland: typeof mountIsland;
  createLineIcon: (path: string, strokeWidth?: string) => SVGElement;
  CLOSE_ICON_PATH: string;
  createPressable: (className: string, text?: string) => HTMLButtonElement;
  Pressable: SolidComponentFn;
  button: (options: Record<string, unknown>) => HTMLButtonElement;
  linkButton: (options: Record<string, unknown>) => HTMLAnchorElement;
  menuButton: (options: Record<string, unknown>) => HTMLButtonElement;
  outlineIconButton: (options: Record<string, unknown>) => { element: HTMLButtonElement; setState: (state: string) => void };
  Button: SolidComponentFn;
  LinkButton: SolidComponentFn;
  MenuButton: SolidComponentFn;
  OutlineIconButton: SolidComponentFn;
  textInput: (options?: Record<string, unknown>) => HTMLInputElement;
  textArea: (options?: Record<string, unknown>) => HTMLTextAreaElement;
  TextInput: SolidComponentFn;
  TextArea: SolidComponentFn;
  field: (options: Record<string, unknown>) => { element: HTMLElement; setError: (text: string) => void; setHint: (text: string) => void };
  Field: SolidComponentFn;
}

export async function verifyUiPrimitivesParity(page: Page): Promise<UiPrimitivesParityResult> {
  return page.evaluate(async (urls: typeof MODULE_URLS) => {
    const [
      islandMod,
      svgDomMod,
      pressableMod,
      pressableSolidMod,
      buttonMod,
      buttonSolidMod,
      textInputMod,
      textInputSolidMod,
      fieldMod,
      fieldSolidMod,
    ] = await Promise.all([
      import(urls.island),
      import(urls.svgDom),
      import(urls.pressable),
      import(urls.pressableSolid),
      import(urls.button),
      import(urls.buttonSolid),
      import(urls.textInput),
      import(urls.textInputSolid),
      import(urls.field),
      import(urls.fieldSolid),
    ]);

    const modules: LoadedSliceAModules = {
      mountIsland: islandMod.mountIsland,
      createLineIcon: svgDomMod.createLineIcon,
      CLOSE_ICON_PATH: svgDomMod.CLOSE_ICON_PATH,
      createPressable: pressableMod.createPressable,
      Pressable: pressableSolidMod.Pressable,
      button: buttonMod.button,
      linkButton: buttonMod.linkButton,
      menuButton: buttonMod.menuButton,
      outlineIconButton: buttonMod.outlineIconButton,
      Button: buttonSolidMod.Button,
      LinkButton: buttonSolidMod.LinkButton,
      MenuButton: buttonSolidMod.MenuButton,
      OutlineIconButton: buttonSolidMod.OutlineIconButton,
      textInput: textInputMod.textInput,
      textArea: textInputMod.textArea,
      TextInput: textInputSolidMod.TextInput,
      TextArea: textInputSolidMod.TextArea,
      field: fieldMod.field,
      Field: fieldSolidMod.Field,
    };

    const normalizeIdToken = (raw: string): string => raw
      .replace(/\bui-field-[A-Za-z0-9_-]+-(label|control|hint|error)\b/g, 'ui-field-N-$1')
      .replace(/\bui-checkbox-hint-[A-Za-z0-9_-]+\b/g, 'ui-checkbox-hint-N');

    const snapshotNode = (node: Node): unknown => {
      if (node.nodeType === Node.TEXT_NODE) {
        return { text: node.textContent ?? '' };
      }
      if (node.nodeType === Node.COMMENT_NODE) return null;
      if (!(node instanceof Element)) return { nodeType: node.nodeType };

      const attributes: Record<string, string> = {};
      const sortedAttributes = [...node.attributes].sort((left, right) => left.name.localeCompare(right.name));
      for (const attribute of sortedAttributes) {
        if (attribute.name === 'style') continue;
        const normalizedValue = (attribute.name === 'id' || attribute.name === 'for' || attribute.name === 'aria-labelledby' || attribute.name === 'aria-describedby')
          ? normalizeIdToken(attribute.value)
          : attribute.value;
        attributes[attribute.name] = normalizedValue;
      }

      const props: Record<string, unknown> = {};
      if (node instanceof HTMLElement) {
        if (node.hidden) props.hidden = true;
        if (node.tabIndex !== -1 && node.hasAttribute('tabindex')) props.tabIndex = node.tabIndex;
        const meterValue = node.style.getPropertyValue('--meter-value');
        if (meterValue) props.meterValue = meterValue;
      }
      if (node instanceof HTMLButtonElement) {
        props.type = node.type;
        props.disabled = node.disabled;
      }
      if (node instanceof HTMLInputElement) {
        props.type = node.type;
        props.value = node.value;
        props.checked = node.checked;
        props.disabled = node.disabled;
        props.spellcheck = node.spellcheck;
      }
      if (node instanceof HTMLTextAreaElement) {
        props.value = node.value;
        props.rows = node.rows;
        props.disabled = node.disabled;
      }
      if (node instanceof HTMLSelectElement) {
        props.value = node.value;
        props.selectedIndex = node.selectedIndex;
        props.disabled = node.disabled;
      }
      if (node instanceof HTMLDetailsElement) {
        props.open = node.open;
      }

      const childSnapshots = [...node.childNodes]
        .map((child) => snapshotNode(child))
        .filter((entry) => entry !== null);

      return {
        tag: node.tagName.toLowerCase(),
        attributes,
        props,
        children: childSnapshots,
      };
    };

    const assertParity = (
      name: string,
      buildImperative: () => Element,
      renderSolid: () => unknown,
    ): string | null => {
      const imperativeHost = document.createElement('div');
      const solidHost = document.createElement('div');
      document.body.append(imperativeHost, solidHost);
      let dispose: (() => void) | null = null;
      try {
        const imperativeElement = buildImperative();
        imperativeHost.append(imperativeElement);
        dispose = modules.mountIsland(solidHost, () => renderSolid() as never);
        const solidElement = solidHost.firstElementChild;
        if (!solidElement) return `${name}: Solid component rendered no element`;
        const expected = JSON.stringify(snapshotNode(imperativeElement));
        const actual = JSON.stringify(snapshotNode(solidElement));
        if (expected !== actual) {
          return `${name}: DOM mismatch\n  expected: ${expected}\n  actual:   ${actual}`;
        }
        dispose();
        dispose = null;
        if (solidHost.firstElementChild !== null) {
          return `${name}: Solid island left DOM behind after dispose()`;
        }
        return null;
      } finally {
        if (dispose) dispose();
        imperativeHost.remove();
        solidHost.remove();
      }
    };

    const makeIcon = () => modules.createLineIcon(modules.CLOSE_ICON_PATH);

    const cases: readonly { name: string; buildImperative: () => Element; renderSolid: () => unknown }[] = [
      {
        name: 'pressable/basic',
        buildImperative: () => modules.createPressable('ui-chip', 'Run'),
        renderSolid: () => modules.Pressable({ class: 'ui-chip', text: 'Run' }),
      },
      {
        name: 'pressable/no-text',
        buildImperative: () => modules.createPressable('ui-row'),
        renderSolid: () => modules.Pressable({ class: 'ui-row' }),
      },
      {
        name: 'button/primary-shortcut',
        buildImperative: () => modules.button({ variant: 'primary', label: 'Save', size: 'large', textCase: 'sentence', action: 'save', shortcutKey: 'S' }),
        renderSolid: () => modules.Button({ variant: 'primary', label: 'Save', size: 'large', textCase: 'sentence', action: 'save', shortcutKey: 'S' }),
      },
      {
        name: 'button/icon-disabled-hidden',
        buildImperative: () => modules.button({ variant: 'icon', label: 'Close', icon: makeIcon(), size: 'small', disabled: true, hidden: true }),
        renderSolid: () => modules.Button({ variant: 'icon', label: 'Close', icon: makeIcon(), size: 'small', disabled: true, hidden: true }),
      },
      {
        name: 'button/link',
        buildImperative: () => modules.linkButton({ variant: 'secondary', label: 'Docs', href: 'https://example.com', size: 'small' }),
        renderSolid: () => modules.LinkButton({ variant: 'secondary', label: 'Docs', href: 'https://example.com', size: 'small' }),
      },
      {
        name: 'button/menu',
        buildImperative: () => modules.menuButton({ label: 'More', action: 'open-menu' }),
        renderSolid: () => modules.MenuButton({ label: 'More', action: 'open-menu' }),
      },
      {
        name: 'button/outline-icon-toggle',
        buildImperative: () => {
          const handle = modules.outlineIconButton({ label: 'Mute', icon: makeIcon(), states: ['idle', 'off'] });
          handle.setState('off');
          return handle.element;
        },
        renderSolid: () => modules.OutlineIconButton({ label: 'Mute', icon: makeIcon(), states: ['idle', 'off'], state: 'off' }),
      },
      {
        name: 'text-input/default',
        buildImperative: () => modules.textInput({ id: 'host-in', value: 'localhost', placeholder: 'Host', label: 'Host name', size: 'small' }),
        renderSolid: () => modules.TextInput({ id: 'host-in', value: 'localhost', placeholder: 'Host', label: 'Host name', size: 'small' }),
      },
      {
        name: 'text-input/password',
        buildImperative: () => modules.textInput({ type: 'password', value: 'secret', disabled: true, spellcheck: true }),
        renderSolid: () => modules.TextInput({ type: 'password', value: 'secret', disabled: true, spellcheck: true }),
      },
      {
        name: 'text-input/textarea',
        buildImperative: () => modules.textArea({ rows: 5, value: 'notes', placeholder: 'Write', labelledBy: 'notes-lbl' }),
        renderSolid: () => modules.TextArea({ rows: 5, value: 'notes', placeholder: 'Write', labelledBy: 'notes-lbl' }),
      },
      {
        name: 'field/labelable-with-error',
        buildImperative: () => {
          const input = modules.textInput({ placeholder: 'Name' });
          const created = modules.field({ label: 'Project', control: input, hint: 'Short name', layout: 'inline' });
          created.setError('Required');
          return created.element;
        },
        renderSolid: () => modules.Field({
          label: 'Project',
          control: modules.textInput({ placeholder: 'Name' }),
          hint: 'Short name',
          error: 'Required',
          layout: 'inline',
        }),
      },
      {
        name: 'field/non-labelable-group',
        buildImperative: () => {
          const box = document.createElement('div');
          box.textContent = 'Custom';
          return modules.field({ label: 'Mode', control: box, layout: 'grid' }).element;
        },
        renderSolid: () => {
          const box = document.createElement('div');
          box.textContent = 'Custom';
          return modules.Field({ label: 'Mode', control: box, layout: 'grid' });
        },
      },
    ];

    for (const parityCase of cases) {
      const failure = assertParity(parityCase.name, parityCase.buildImperative, parityCase.renderSolid);
      if (failure) return { ok: false, detail: failure };
    }

    return { ok: true, detail: `${cases.length} UI primitive parity cases matched` };
  }, MODULE_URLS);
}
