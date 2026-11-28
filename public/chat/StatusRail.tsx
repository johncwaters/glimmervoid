import { For, Show, createEffect, createMemo } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { paintAgentMark } from '../session-card/agent-mark.ts';
import { Pressable } from '../ui/Pressable.tsx';
import { railGroupsOf, railModelDisplayOf } from './status-rail-core.ts';
import type { RailField } from './status-rail-core.ts';

interface StatusRailProps {
  fields: readonly RailField[];
  isModelPickerOpen?: boolean;
  onChangeModel?: (triggerElement: HTMLButtonElement) => void;
}

function agentMarkDirective(source: () => string | null): (element: HTMLSpanElement) => void {
  let targetElement: HTMLSpanElement | undefined;
  createEffect(source, (agent) => {
    if (targetElement) paintAgentMark(targetElement, agent);
  });
  return (nextElement) => {
    targetElement = nextElement;
    paintAgentMark(nextElement, source());
  };
}

function meterFillWidthDirective(source: () => number): (element: HTMLSpanElement) => void {
  let targetElement: HTMLSpanElement | undefined;
  createEffect(source, (fillPct) => {
    if (targetElement) targetElement.style.width = `${fillPct}%`;
  });
  return (nextElement) => {
    targetElement = nextElement;
    nextElement.style.width = `${source()}%`;
  };
}

export function StatusRail(props: StatusRailProps): JSX.Element {
  const modelDisplay = createMemo(() => railModelDisplayOf(props.fields));
  const readingGroups = createMemo(() => railGroupsOf(props.fields));

  return (
    <div
      class="chat-rail"
      ref={(element) => element.setAttribute('aria-label', 'Session status')}
    >
      <div class="chat-rail-fields">
        <span class="chat-rail-group" data-group="identity" hidden={!modelDisplay().isShown}>
          <span
            class="chat-rail-agent"
            hidden={true}
            ref={agentMarkDirective(() => modelDisplay().agent)}
          />
          <span
            class="chat-rail-field"
            data-kind="model"
            hidden={modelDisplay().canChange}
          >
            {modelDisplay().text}
          </span>
          <Pressable
            class="chat-rail-field chat-rail-model"
            data-kind="model"
            aria-expanded={props.isModelPickerOpen ? 'true' : 'false'}
            aria-label={modelDisplay().ariaLabel}
            hidden={!modelDisplay().canChange}
            onClick={(event) => {
              const triggerElement = event.currentTarget;
              props.onChangeModel?.(triggerElement);
              triggerElement.dispatchEvent(new CustomEvent('chat-change-model', { bubbles: true, composed: true }));
            }}
          >
            {modelDisplay().text}
          </Pressable>
        </span>
        <span class="chat-rail-readings">
          <For each={readingGroups()}>
            {(section) => (
              <span class="chat-rail-group" data-group={section.group}>
                <For each={section.fields}>
                  {(field) => (
                    <span
                      class="chat-rail-field"
                      data-kind={field.kind}
                      data-level={field.level ?? undefined}
                    >
                      <span class="chat-rail-text">{field.text}</span>
                      <Show when={field.fillPct !== null}>
                        <span class="chat-rail-meter">
                          <span
                            class="chat-rail-meter-fill"
                            ref={meterFillWidthDirective(() => field.fillPct ?? 0)}
                          />
                        </span>
                      </Show>
                    </span>
                  )}
                </For>
              </span>
            )}
          </For>
        </span>
      </div>
    </div>
  );
}
