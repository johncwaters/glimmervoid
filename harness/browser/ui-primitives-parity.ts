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
  checkbox: '/ui/checkbox.ts',
  checkboxSolid: '/ui/Checkbox.tsx',
  switchMod: '/ui/switch.ts',
  switchSolid: '/ui/Switch.tsx',
  select: '/ui/select.ts',
  selectSolid: '/ui/Select.tsx',
  segmented: '/ui/segmented.ts',
  segmentedSolid: '/ui/Segmented.tsx',
  disclosure: '/ui/disclosure.ts',
  disclosureSolid: '/ui/Disclosure.tsx',
  tag: '/ui/tag.ts',
  tagSolid: '/ui/Tag.tsx',
  keycap: '/ui/keycap.ts',
  keycapSolid: '/ui/Keycap.tsx',
  meter: '/ui/meter.ts',
  meterSolid: '/ui/Meter.tsx',
  emptyState: '/ui/empty-state.ts',
  emptyStateSolid: '/ui/EmptyState.tsx',
  sectionHeading: '/ui/section-heading.ts',
  sectionHeadingSolid: '/ui/SectionHeading.tsx',
  copyButton: '/ui/copy-button.ts',
  copyButtonSolid: '/ui/CopyButton.tsx',
  notice: '/ui/notice.ts',
  noticeSolid: '/ui/Notice.tsx',
  popupMenu: '/ui/popup-menu.ts',
  popupMenuSolid: '/ui/PopupMenu.tsx',
} as const;

interface LoadedParityModules {
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
  checkbox: (options: Record<string, unknown>) => { element: HTMLLabelElement; input: HTMLInputElement };
  radio: (options: Record<string, unknown>) => { element: HTMLLabelElement; input: HTMLInputElement };
  Checkbox: SolidComponentFn;
  Radio: SolidComponentFn;
  switchInput: (options: Record<string, unknown>) => HTMLInputElement;
  Switch: SolidComponentFn;
  select: (options: Record<string, unknown>) => { element: HTMLSelectElement; setOptions: (options: readonly unknown[]) => void };
  Select: SolidComponentFn;
  segmented: (options: Record<string, unknown>) => { element: HTMLDivElement; setValue: (value: string) => void; focus: () => void };
  Segmented: SolidComponentFn;
  disclosure: (options: Record<string, unknown>) => { element: HTMLDetailsElement; summary: HTMLElement; body: HTMLDivElement };
  detailsBlock: (text: string) => HTMLDetailsElement;
  Disclosure: SolidComponentFn;
  DetailsBlock: SolidComponentFn;
  tag: (options: Record<string, unknown>) => HTMLSpanElement;
  Tag: SolidComponentFn;
  keycap: (text: string, options?: Record<string, unknown>) => HTMLElement;
  keyChord: (keys: readonly string[]) => HTMLElement;
  Keycap: SolidComponentFn;
  KeyChord: SolidComponentFn;
  meter: (options: Record<string, unknown>) => { element: HTMLSpanElement; setValue: (value: number, valueText?: string) => void; setTone: (tone: string) => void };
  Meter: SolidComponentFn;
  emptyState: (options: Record<string, unknown>) => HTMLElement;
  EmptyState: SolidComponentFn;
  sectionHeading: (options: Record<string, unknown>) => { element: HTMLDivElement; setCount: (count: number | string | null) => void };
  SectionHeading: SolidComponentFn;
  copyButton: (options: Record<string, unknown>) => { element: HTMLSpanElement; button: HTMLButtonElement; clearStatus: () => void };
  CopyButton: SolidComponentFn;
  createNotice: (options: Record<string, unknown>) => { element: HTMLDivElement; show: (content: Record<string, unknown>) => void; hide: () => void };
  Notice: SolidComponentFn;
}

export async function verifyUiPrimitivesParity(page: Page): Promise<UiPrimitivesParityResult> {
  const staticResult = await page.evaluate(async (urls: typeof MODULE_URLS) => {
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
      checkboxMod,
      checkboxSolidMod,
      switchMod,
      switchSolidMod,
      selectMod,
      selectSolidMod,
      segmentedMod,
      segmentedSolidMod,
      disclosureMod,
      disclosureSolidMod,
      tagMod,
      tagSolidMod,
      keycapMod,
      keycapSolidMod,
      meterMod,
      meterSolidMod,
      emptyStateMod,
      emptyStateSolidMod,
      sectionHeadingMod,
      sectionHeadingSolidMod,
      copyButtonMod,
      copyButtonSolidMod,
      noticeMod,
      noticeSolidMod,
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
      import(urls.checkbox),
      import(urls.checkboxSolid),
      import(urls.switchMod),
      import(urls.switchSolid),
      import(urls.select),
      import(urls.selectSolid),
      import(urls.segmented),
      import(urls.segmentedSolid),
      import(urls.disclosure),
      import(urls.disclosureSolid),
      import(urls.tag),
      import(urls.tagSolid),
      import(urls.keycap),
      import(urls.keycapSolid),
      import(urls.meter),
      import(urls.meterSolid),
      import(urls.emptyState),
      import(urls.emptyStateSolid),
      import(urls.sectionHeading),
      import(urls.sectionHeadingSolid),
      import(urls.copyButton),
      import(urls.copyButtonSolid),
      import(urls.notice),
      import(urls.noticeSolid),
    ]);

    const modules: LoadedParityModules = {
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
      checkbox: checkboxMod.checkbox,
      radio: checkboxMod.radio,
      Checkbox: checkboxSolidMod.Checkbox,
      Radio: checkboxSolidMod.Radio,
      switchInput: switchMod.switchInput,
      Switch: switchSolidMod.Switch,
      select: selectMod.select,
      Select: selectSolidMod.Select,
      segmented: segmentedMod.segmented,
      Segmented: segmentedSolidMod.Segmented,
      disclosure: disclosureMod.disclosure,
      detailsBlock: disclosureMod.detailsBlock,
      Disclosure: disclosureSolidMod.Disclosure,
      DetailsBlock: disclosureSolidMod.DetailsBlock,
      tag: tagMod.tag,
      Tag: tagSolidMod.Tag,
      keycap: keycapMod.keycap,
      keyChord: keycapMod.keyChord,
      Keycap: keycapSolidMod.Keycap,
      KeyChord: keycapSolidMod.KeyChord,
      meter: meterMod.meter,
      Meter: meterSolidMod.Meter,
      emptyState: emptyStateMod.emptyState,
      EmptyState: emptyStateSolidMod.EmptyState,
      sectionHeading: sectionHeadingMod.sectionHeading,
      SectionHeading: sectionHeadingSolidMod.SectionHeading,
      copyButton: copyButtonMod.copyButton,
      CopyButton: copyButtonSolidMod.CopyButton,
      createNotice: noticeMod.createNotice,
      Notice: noticeSolidMod.Notice,
    };

    const normalizeIdToken = (raw: string): string => raw
      .replace(/\bui-field-[A-Za-z0-9_-]+-(label|control|hint|error)\b/g, 'ui-field-N-$1')
      .replace(/\bui-checkbox-hint-[A-Za-z0-9_-]+\b/g, 'ui-checkbox-hint-N');

    const snapshotNode = (node: Node): unknown => {
      if (node.nodeType === Node.TEXT_NODE) {
        if ((node.textContent ?? '') === '') return null;
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
      {
        name: 'checkbox/checked-with-hint',
        buildImperative: () => modules.checkbox({ label: 'Enable alerts', checked: true, hint: 'Browser notifications', accessibleName: 'Alerts toggle' }).element,
        renderSolid: () => modules.Checkbox({ label: 'Enable alerts', checked: true, hint: 'Browser notifications', accessibleName: 'Alerts toggle' }),
      },
      {
        name: 'checkbox/radio-disabled',
        buildImperative: () => modules.radio({ label: 'Compact', name: 'density', value: 'compact', disabled: true }).element,
        renderSolid: () => modules.Radio({ label: 'Compact', name: 'density', value: 'compact', disabled: true }),
      },
      {
        name: 'switch/labelled',
        buildImperative: () => modules.switchInput({ label: 'Auto-resume', checked: true, onChange: () => {} }),
        renderSolid: () => modules.Switch({ label: 'Auto-resume', checked: true, onChange: () => {} }),
      },
      {
        name: 'switch/labelledby-disabled',
        buildImperative: () => modules.switchInput({ labelledBy: 'mute-lbl', checked: false, disabled: true, onChange: () => {} }),
        renderSolid: () => modules.Switch({ labelledBy: 'mute-lbl', checked: false, disabled: true, onChange: () => {} }),
      },
      {
        name: 'select/selected-small',
        buildImperative: () => modules.select({
          options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }],
          value: 'b',
          size: 'small',
          id: 'mode-sel',
          label: 'Mode',
        }).element,
        renderSolid: () => modules.Select({
          options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }],
          value: 'b',
          size: 'small',
          id: 'mode-sel',
          label: 'Mode',
        }),
      },
      {
        name: 'select/missing-blank-disabled',
        buildImperative: () => modules.select({
          options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }],
          value: 'missing',
          missingValue: 'blank',
          labelledBy: 'mode-lbl',
          disabled: true,
        }).element,
        renderSolid: () => modules.Select({
          options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }],
          value: 'missing',
          missingValue: 'blank',
          labelledBy: 'mode-lbl',
          disabled: true,
        }),
      },
      {
        name: 'segmented/with-icon-fill',
        buildImperative: () => modules.segmented({
          label: 'Layout',
          options: [
            { value: 'grid', label: 'Grid', icon: makeIcon() },
            { value: 'list', label: 'List' },
          ],
          value: 'list',
          width: 'fill',
          size: 'small',
          onChange: () => {},
        }).element,
        renderSolid: () => modules.Segmented({
          label: 'Layout',
          options: [
            { value: 'grid', label: 'Grid', icon: makeIcon() },
            { value: 'list', label: 'List' },
          ],
          value: 'list',
          width: 'fill',
          size: 'small',
          onChange: () => {},
        }),
      },
      {
        name: 'disclosure/closed-lazy',
        buildImperative: () => modules.disclosure({
          summary: 'Advanced',
          marker: 'chevron',
          body: () => {
            const paragraph = document.createElement('p');
            paragraph.textContent = 'Lazy body';
            return paragraph;
          },
        }).element,
        renderSolid: () => modules.Disclosure({
          summary: 'Advanced',
          marker: 'chevron',
          body: () => {
            const paragraph = document.createElement('p');
            paragraph.textContent = 'Lazy body';
            return paragraph;
          },
        }),
      },
      {
        name: 'disclosure/open-lazy',
        buildImperative: () => modules.disclosure({
          summary: 'Diagnostics',
          open: true,
          body: () => {
            const paragraph = document.createElement('p');
            paragraph.textContent = 'Loaded';
            return paragraph;
          },
        }).element,
        renderSolid: () => modules.Disclosure({
          summary: 'Diagnostics',
          open: true,
          body: () => {
            const paragraph = document.createElement('p');
            paragraph.textContent = 'Loaded';
            return paragraph;
          },
        }),
      },
      {
        name: 'disclosure/details-block',
        buildImperative: () => modules.detailsBlock('Error: connection refused'),
        renderSolid: () => modules.DetailsBlock({ text: 'Error: connection refused' }),
      },
      {
        name: 'tag/default',
        buildImperative: () => modules.tag({ text: 'Draft' }),
        renderSolid: () => modules.Tag({ text: 'Draft' }),
      },
      {
        name: 'tag/pill-warning',
        buildImperative: () => modules.tag({ text: 'Stale', tone: 'warning', shape: 'pill' }),
        renderSolid: () => modules.Tag({ text: 'Stale', tone: 'warning', shape: 'pill' }),
      },
      {
        name: 'keycap/neutral',
        buildImperative: () => modules.keycap('Esc'),
        renderSolid: () => modules.Keycap({ text: 'Esc' }),
      },
      {
        name: 'keycap/accent',
        buildImperative: () => modules.keycap('K', { tone: 'accent' }),
        renderSolid: () => modules.Keycap({ text: 'K', tone: 'accent' }),
      },
      {
        name: 'keycap/chord',
        buildImperative: () => modules.keyChord(['Cmd', 'Shift', 'K']),
        renderSolid: () => modules.KeyChord({ keys: ['Cmd', 'Shift', 'K'] }),
      },
      {
        name: 'meter/decorative',
        buildImperative: () => modules.meter({ value: 0.35 }).element,
        renderSolid: () => modules.Meter({ value: 0.35 }),
      },
      {
        name: 'meter/labelled-clamped',
        buildImperative: () => modules.meter({
          value: 1.4,
          label: 'Context window',
          valueText: '100% full',
          tone: 'waiting',
          thickness: 'thick',
        }).element,
        renderSolid: () => modules.Meter({
          value: 1.4,
          label: 'Context window',
          valueText: '100% full',
          tone: 'waiting',
          thickness: 'thick',
        }),
      },
      {
        name: 'empty-state/text-only',
        buildImperative: () => modules.emptyState({ text: 'No sessions yet.' }),
        renderSolid: () => modules.EmptyState({ text: 'No sessions yet.' }),
      },
      {
        name: 'empty-state/boxed-with-action',
        buildImperative: () => modules.emptyState({
          title: 'Nothing running',
          text: 'Start a session to begin.',
          variant: 'boxed',
          actions: [modules.button({ variant: 'primary', label: 'New session' })],
        }),
        renderSolid: () => modules.EmptyState({
          title: 'Nothing running',
          text: 'Start a session to begin.',
          variant: 'boxed',
          actions: [modules.button({ variant: 'primary', label: 'New session' })],
        }),
      },
      {
        name: 'section-heading/h2-with-count-hint-actions',
        buildImperative: () => modules.sectionHeading({
          title: 'Sessions',
          level: 2,
          count: 3,
          tone: 'strong',
          hint: 'Active',
          actions: [modules.button({ variant: 'quiet', size: 'small', label: 'Refresh' })],
        }).element,
        renderSolid: () => modules.SectionHeading({
          title: 'Sessions',
          level: 2,
          count: 3,
          tone: 'strong',
          hint: 'Active',
          actions: [modules.button({ variant: 'quiet', size: 'small', label: 'Refresh' })],
        }),
      },
      {
        name: 'section-heading/none-empty-count',
        buildImperative: () => modules.sectionHeading({
          title: 'Other',
          level: 'none',
        }).element,
        renderSolid: () => modules.SectionHeading({
          title: 'Other',
          level: 'none',
        }),
      },
      {
        name: 'copy-button/default',
        buildImperative: () => modules.copyButton({
          text: () => 'npm test',
          label: 'Copy command',
          accessibleLabel: 'Copy test command',
          action: 'copy-cmd',
          variant: 'quiet',
          size: 'small',
        }).element,
        renderSolid: () => modules.CopyButton({
          text: () => 'npm test',
          label: 'Copy command',
          accessibleLabel: 'Copy test command',
          action: 'copy-cmd',
          variant: 'quiet',
          size: 'small',
        }),
      },
      {
        name: 'notice/hidden-icon-dismiss',
        buildImperative: () => modules.createNotice({
          id: 'update-notice',
          dismissLabel: 'Dismiss',
          isDismissIcon: true,
          onDismiss: () => {},
        }).element,
        renderSolid: () => modules.Notice({
          id: 'update-notice',
          dismissLabel: 'Dismiss',
          isDismissIcon: true,
          onDismiss: () => {},
        }),
      },
      {
        name: 'notice/shown-with-command-and-meta',
        buildImperative: () => {
          const noticeHandle = modules.createNotice({
            id: 'update-notice',
            dismissLabel: 'Dismiss',
            isDismissIcon: false,
            onDismiss: () => {},
          });
          noticeHandle.show({
            text: 'Update available',
            tone: 'warning',
            actions: [modules.button({ variant: 'secondary', size: 'small', label: 'Reload' })],
            command: 'npm i -g glimmervoid',
            meta: 'v0.67.0',
          });
          return noticeHandle.element;
        },
        renderSolid: () => modules.Notice({
          id: 'update-notice',
          dismissLabel: 'Dismiss',
          isDismissIcon: false,
          onDismiss: () => {},
          shown: true,
          text: 'Update available',
          tone: 'warning',
          actions: [modules.button({ variant: 'secondary', size: 'small', label: 'Reload' })],
          command: 'npm i -g glimmervoid',
          meta: 'v0.67.0',
        }),
      },
    ];

    for (const parityCase of cases) {
      const failure = assertParity(parityCase.name, parityCase.buildImperative, parityCase.renderSolid);
      if (failure) return { ok: false, detail: failure };
    }

    return { ok: true, detail: `${cases.length} UI primitive parity cases matched` };
  }, MODULE_URLS);

  if (!staticResult.ok) return staticResult;
  const popupMenuResult = await verifyPopupMenuBehavior(page);
  if (!popupMenuResult.ok) return popupMenuResult;
  return { ok: true, detail: `${staticResult.detail}; ${popupMenuResult.detail}` };
}

async function verifyPopupMenuBehavior(page: Page): Promise<UiPrimitivesParityResult> {
  const setupError = await page.evaluate(async (urls: { island: string; pressable: string; popupMenu: string; popupMenuSolid: string }) => {
    const [islandMod, pressableMod, popupMenuMod, popupMenuSolidMod] = await Promise.all([
      import(urls.island),
      import(urls.pressable),
      import(urls.popupMenu),
      import(urls.popupMenuSolid),
    ]);

    const mountRoot = document.createElement('div');
    mountRoot.id = 'popup-menu-parity-host';
    mountRoot.style.position = 'fixed';
    mountRoot.style.bottom = '80px';
    mountRoot.style.left = '16px';
    mountRoot.style.zIndex = '9999';
    mountRoot.style.display = 'flex';
    mountRoot.style.gap = '24px';
    document.body.append(mountRoot);

    const outsideButton = document.createElement('button');
    outsideButton.id = 'popup-menu-outside';
    outsideButton.type = 'button';
    outsideButton.textContent = 'Outside';
    outsideButton.style.position = 'fixed';
    outsideButton.style.bottom = '16px';
    outsideButton.style.right = '16px';
    outsideButton.style.zIndex = '9999';
    mountRoot.append(outsideButton);

    const solidHost = document.createElement('div');
    solidHost.id = 'popup-menu-solid-host';
    mountRoot.append(solidHost);

    const selectedItems: string[] = [];
    const recordSelection = (entry: string) => {
      selectedItems.push(entry);
      mountRoot.dataset.selected = selectedItems.join(',');
    };
    const labels = ['Alpha', 'Beta', 'Restart', 'Remove', 'Snooze'];
    let docEscapeCount = 0;
    const onDocEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      docEscapeCount += 1;
      mountRoot.dataset.docEscapes = String(docEscapeCount);
    };
    document.addEventListener('keydown', onDocEscape);

    const disposeSolid = islandMod.mountIsland(solidHost, () => popupMenuSolidMod.PopupMenu({
      id: 'solid-popup-menu-panel',
      triggerLabel: 'Solid menu',
      triggerAction: 'solid-popup-trigger',
      menuLabel: 'Solid actions',
      items: labels.map((label) => ({
        id: label.toLowerCase(),
        label,
        tone: label === 'Remove' ? 'danger' : label === 'Restart' ? 'warning' : 'neutral',
        onSelect: () => {
          recordSelection(label);
          if (label === 'Alpha') outsideButton.focus();
        },
      })),
    }));

    const imperativeHost = document.createElement('div');
    imperativeHost.id = 'popup-menu-imperative-host';
    imperativeHost.className = 'session-overflow';
    const imperativeTrigger = pressableMod.createPressable('ui-button', 'Imperative menu');
    imperativeTrigger.dataset.action = 'imperative-popup-trigger';
    const imperativeMenu = document.createElement('div');
    imperativeMenu.id = 'imperative-popup-menu-panel';
    const imperativeController = new AbortController();
    const disabledItem = popupMenuMod.buildMenuItem('Readonly', 'visible');
    disabledItem.disabled = true;
    imperativeMenu.append(disabledItem);
    for (const label of labels) {
      const item = popupMenuMod.buildMenuItem(label, 'visible', {
        tone: label === 'Remove' ? 'danger' : label === 'Restart' ? 'warning' : 'neutral',
      });
      item.addEventListener('click', () => recordSelection(`imp:${label}`), { signal: imperativeController.signal });
      imperativeMenu.append(item);
    }
    imperativeHost.append(imperativeTrigger, imperativeMenu);
    mountRoot.append(imperativeHost);
    popupMenuMod.popupMenu({
      trigger: imperativeTrigger,
      menu: imperativeMenu,
      signal: imperativeController.signal,
    });

    mountRoot.addEventListener('popup-menu-cleanup', () => {
      document.removeEventListener('keydown', onDocEscape);
      disposeSolid();
      imperativeController.abort();
      mountRoot.remove();
    }, { once: true });
    return null;
  }, {
    island: MODULE_URLS.island,
    pressable: MODULE_URLS.pressable,
    popupMenu: MODULE_URLS.popupMenu,
    popupMenuSolid: MODULE_URLS.popupMenuSolid,
  });

  if (setupError) return { ok: false, detail: setupError };

  try {
    const readMenuSnapshot = async (triggerSelector: string, menuSelector: string) => page.evaluate(([tSel, mSel]) => {
      const trigger = document.querySelector<HTMLElement>(tSel);
      const menu = document.querySelector<HTMLElement>(mSel);
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return {
        expanded: trigger?.getAttribute('aria-expanded') ?? null,
        hidden: menu?.hidden ?? null,
        dataState: menu?.dataset.state ?? null,
        popoverOpen: menu ? menu.matches(':popover-open') : false,
        activeText: active?.textContent?.trim() ?? null,
        activeIsTrigger: active === trigger,
        activeId: active?.id ?? null,
      };
    }, [triggerSelector, menuSelector]);

    const solidTrigger = 'button[data-action="solid-popup-trigger"]';
    const solidMenu = '#solid-popup-menu-panel';
    const impTrigger = 'button[data-action="imperative-popup-trigger"]';
    const impMenu = '#imperative-popup-menu-panel';

    await page.locator(solidTrigger).click();
    let snap = await readMenuSnapshot(solidTrigger, solidMenu);
    if (!snap.popoverOpen || snap.hidden || snap.expanded !== 'true' || snap.dataState !== 'open') {
      return { ok: false, detail: `PopupMenu click open failed: ${JSON.stringify(snap)}` };
    }

    await page.locator(solidTrigger).click();
    snap = await readMenuSnapshot(solidTrigger, solidMenu);
    if (snap.popoverOpen || !snap.hidden || snap.expanded !== 'false' || snap.dataState !== 'closed') {
      return { ok: false, detail: `PopupMenu trigger click toggle close failed: ${JSON.stringify(snap)}` };
    }

    await page.locator(solidTrigger).focus();
    await page.keyboard.press('ArrowDown');
    snap = await readMenuSnapshot(solidTrigger, solidMenu);
    if (!snap.popoverOpen || snap.activeText !== 'Alpha') {
      return { ok: false, detail: `PopupMenu ArrowDown open failed: ${JSON.stringify(snap)}` };
    }

    await page.keyboard.press('ArrowDown');
    snap = await readMenuSnapshot(solidTrigger, solidMenu);
    if (snap.activeText !== 'Beta') return { ok: false, detail: `PopupMenu ArrowDown next failed: ${JSON.stringify(snap)}` };

    await page.keyboard.press('End');
    snap = await readMenuSnapshot(solidTrigger, solidMenu);
    if (snap.activeText !== 'Snooze') return { ok: false, detail: `PopupMenu End failed: ${JSON.stringify(snap)}` };

    await page.keyboard.press('Home');
    snap = await readMenuSnapshot(solidTrigger, solidMenu);
    if (snap.activeText !== 'Alpha') return { ok: false, detail: `PopupMenu Home failed: ${JSON.stringify(snap)}` };

    await page.keyboard.press('ArrowUp');
    snap = await readMenuSnapshot(solidTrigger, solidMenu);
    if (snap.activeText !== 'Snooze') return { ok: false, detail: `PopupMenu ArrowUp wrap failed: ${JSON.stringify(snap)}` };

    await page.keyboard.press('r');
    snap = await readMenuSnapshot(solidTrigger, solidMenu);
    if (snap.activeText !== 'Restart') return { ok: false, detail: `PopupMenu typeahead r failed: ${JSON.stringify(snap)}` };

    await page.keyboard.press('r');
    snap = await readMenuSnapshot(solidTrigger, solidMenu);
    if (snap.activeText !== 'Remove') return { ok: false, detail: `PopupMenu typeahead repeat r failed: ${JSON.stringify(snap)}` };

    await page.keyboard.press('Escape');
    snap = await readMenuSnapshot(solidTrigger, solidMenu);
    const docEscapes = await page.evaluate(() => Number(document.getElementById('popup-menu-parity-host')?.dataset.docEscapes ?? '0'));
    if (snap.popoverOpen || !snap.hidden || !snap.activeIsTrigger || docEscapes !== 0) {
      return { ok: false, detail: `PopupMenu Escape dismiss + focus return + stopPropagation failed: ${JSON.stringify({ snap, docEscapes })}` };
    }

    await page.locator(solidTrigger).click();
    await page.keyboard.press('r');
    snap = await readMenuSnapshot(solidTrigger, solidMenu);
    if (!snap.popoverOpen || snap.activeText !== 'Restart') {
      return { ok: false, detail: `PopupMenu click-open trigger typeahead failed: ${JSON.stringify(snap)}` };
    }

    await page.locator('#popup-menu-outside').click();
    snap = await readMenuSnapshot(solidTrigger, solidMenu);
    if (snap.popoverOpen || !snap.hidden || snap.activeIsTrigger) {
      return { ok: false, detail: `PopupMenu light dismiss failed: ${JSON.stringify(snap)}` };
    }

    await page.locator(solidTrigger).click();
    await page.locator(`${solidMenu} [data-menu-item="alpha"]`).click();
    snap = await readMenuSnapshot(solidTrigger, solidMenu);
    if (snap.popoverOpen || !snap.hidden || snap.activeId !== 'popup-menu-outside') {
      return { ok: false, detail: `PopupMenu onSelect focus handoff failed: ${JSON.stringify(snap)}` };
    }

    await page.locator(solidTrigger).click();
    await page.locator(`${solidMenu} [data-menu-item="beta"]`).click();
    snap = await readMenuSnapshot(solidTrigger, solidMenu);
    const selectedAfterSolid = await page.evaluate(() => (document.getElementById('popup-menu-parity-host')?.dataset.selected ?? '').split(',').filter(Boolean));
    if (snap.popoverOpen || !snap.hidden || !snap.activeIsTrigger || !selectedAfterSolid.includes('Beta')) {
      return { ok: false, detail: `PopupMenu item select failed: ${JSON.stringify({ snap, selectedAfterSolid })}` };
    }

    await page.locator(impTrigger).click();
    await page.keyboard.press('r');
    snap = await readMenuSnapshot(impTrigger, impMenu);
    if (snap.hidden || snap.activeText !== 'Restart') {
      return { ok: false, detail: `popupMenu click-open trigger typeahead (skipping disabled Readonly) failed: ${JSON.stringify(snap)}` };
    }
    await page.keyboard.press('Escape');

    await page.locator(impTrigger).focus();
    await page.keyboard.press('ArrowDown');
    snap = await readMenuSnapshot(impTrigger, impMenu);
    if (snap.hidden || snap.expanded !== 'true' || snap.dataState !== 'open' || snap.activeText !== 'Alpha') {
      return { ok: false, detail: `popupMenu ArrowDown open failed: ${JSON.stringify(snap)}` };
    }

    await page.keyboard.press('End');
    snap = await readMenuSnapshot(impTrigger, impMenu);
    if (snap.activeText !== 'Snooze') return { ok: false, detail: `popupMenu End failed: ${JSON.stringify(snap)}` };

    await page.keyboard.press('Home');
    snap = await readMenuSnapshot(impTrigger, impMenu);
    if (snap.activeText !== 'Alpha') return { ok: false, detail: `popupMenu Home failed: ${JSON.stringify(snap)}` };

    await page.keyboard.press('r');
    snap = await readMenuSnapshot(impTrigger, impMenu);
    if (snap.activeText !== 'Restart') return { ok: false, detail: `popupMenu typeahead r failed: ${JSON.stringify(snap)}` };

    await page.keyboard.press('r');
    snap = await readMenuSnapshot(impTrigger, impMenu);
    if (snap.activeText !== 'Remove') return { ok: false, detail: `popupMenu typeahead repeat r failed: ${JSON.stringify(snap)}` };

    await page.keyboard.press('Escape');
    snap = await readMenuSnapshot(impTrigger, impMenu);
    if (!snap.hidden || !snap.activeIsTrigger) {
      return { ok: false, detail: `popupMenu Escape dismiss + focus return failed: ${JSON.stringify(snap)}` };
    }

    await page.locator(impTrigger).click();
    await page.locator('#popup-menu-outside').click();
    snap = await readMenuSnapshot(impTrigger, impMenu);
    if (!snap.hidden) {
      return { ok: false, detail: `popupMenu light dismiss failed: ${JSON.stringify(snap)}` };
    }

    return { ok: true, detail: 'PopupMenu (Popover API) + popupMenu (imperative) keyboard, typeahead, Escape, and light dismiss passed' };
  } finally {
    await page.evaluate(() => {
      document.getElementById('popup-menu-parity-host')?.dispatchEvent(new Event('popup-menu-cleanup'));
    });
  }
}
