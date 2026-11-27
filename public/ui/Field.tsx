import { Show, children, createEffect, createMemo, createSignal, createUniqueId } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { fieldDescriptor, isLabelableTagName } from './field-core.ts';
import type { FieldLayout } from './field-core.ts';

type FieldProps = {
  label: string;
  control?: HTMLElement;
  labelTarget?: HTMLElement;
  hint?: string;
  error?: string;
  layout?: FieldLayout;
  children?: JSX.Element;
};

function firstHtmlElement(resolved: unknown): HTMLElement | null {
  if (resolved instanceof HTMLElement) return resolved;
  if (!Array.isArray(resolved)) return null;
  for (const item of resolved) {
    if (item instanceof HTMLElement) return item;
  }
  return null;
}

export function Field(props: FieldProps): JSX.Element {
  const idPrefix = `ui-field-${createUniqueId()}`;
  const [wrapperElement, setWrapperElement] = createSignal<HTMLDivElement | null>(null);
  const resolvedChildren = children(() => props.children);
  const targetElement = createMemo<HTMLElement | null>(() => {
    if (props.labelTarget) return props.labelTarget;
    if (props.control) return props.control;
    return firstHtmlElement(resolvedChildren());
  });
  const initialTargetMetadata = createMemo(() => {
    const target = targetElement();
    if (!target) {
      return {
        isTargetLabelable: false,
        targetId: '',
        targetHasRole: false,
        existingDescribedBy: null as string | null,
      };
    }
    return {
      isTargetLabelable: isLabelableTagName(target.tagName),
      targetId: target.id,
      targetHasRole: target.hasAttribute('role'),
      existingDescribedBy: target.getAttribute('aria-describedby'),
    };
  });

  const descriptor = createMemo(() => {
    const targetInfo = initialTargetMetadata();
    return fieldDescriptor({
      idPrefix,
      label: props.label,
      isTargetLabelable: targetInfo.isTargetLabelable,
      targetId: targetInfo.targetId,
      targetHasRole: targetInfo.targetHasRole,
      existingDescribedBy: targetInfo.existingDescribedBy,
      hint: props.hint,
      error: props.error,
      layout: props.layout,
    });
  });

  let previousDescribed: HTMLElement | null = null;

  const syncAria = (wrapper: HTMLDivElement | null, target: HTMLElement | null, current: ReturnType<typeof descriptor>) => {
    if (target && current.assignedTargetId && !target.id) target.id = current.assignedTargetId;
    if (wrapper) {
      if (current.wrapperRole) wrapper.setAttribute('role', current.wrapperRole);
      if (!current.wrapperRole) wrapper.removeAttribute('role');
    }
    const described = current.describedIsWrapper ? wrapper : target;
    if (previousDescribed && previousDescribed !== described) {
      previousDescribed.removeAttribute('aria-labelledby');
      previousDescribed.removeAttribute('aria-describedby');
      previousDescribed.removeAttribute('aria-invalid');
    }
    previousDescribed = described;
    if (!described) return;
    if (current.ariaLabelledBy) described.setAttribute('aria-labelledby', current.ariaLabelledBy);
    if (!current.ariaLabelledBy) described.removeAttribute('aria-labelledby');
    described.setAttribute('aria-describedby', current.ariaDescribedBy);
    if (current.ariaInvalid) described.setAttribute('aria-invalid', current.ariaInvalid);
    if (!current.ariaInvalid) described.removeAttribute('aria-invalid');
  };

  createEffect(
    () => ({ wrapper: wrapperElement(), target: targetElement(), current: descriptor() }),
    ({ wrapper, target, current }) => syncAria(wrapper, target, current),
  );

  return (
    <div
      ref={(element) => {
        setWrapperElement(element);
        syncAria(element, targetElement(), descriptor());
      }}
      class={descriptor().className}
      data-layout={descriptor().layout}
    >
      <Show
        when={descriptor().labelTag === 'label'}
        fallback={
          <span class="ui-field-label" id={descriptor().labelId}>
            {props.label}
          </span>
        }
      >
        <label class="ui-field-label" id={descriptor().labelId} for={descriptor().labelFor}>
          {props.label}
        </label>
      </Show>
      {props.control ?? resolvedChildren()}
      <span class="ui-field-hint" id={descriptor().hintId} hidden={descriptor().hintHidden}>
        {descriptor().hintText}
      </span>
      <span class="ui-field-error" id={descriptor().errorId} role="alert" hidden={descriptor().errorHidden}>
        {descriptor().errorText}
      </span>
    </div>
  );
}
