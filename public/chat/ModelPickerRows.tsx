import { For, Match, Show, Switch } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ModelProvider } from '#shared/contracts/agent-models.ts';
import { Pressable } from '../ui/Pressable.tsx';
import type { ModelPickerRow } from './model-picker-core.ts';

interface ModelPickerRowsProps {
  rows: readonly ModelPickerRow[];
  onPickModel: (provider: ModelProvider, modelId: string) => void;
  onPickTypedModel: (provider: ModelProvider, modelId: string) => void;
  onPickEffort: (effort: string | null) => void;
  onBack: () => void;
}

export function ModelPickerRows(props: ModelPickerRowsProps): JSX.Element {
  return (
    <For each={props.rows} keyed={(row) => row.key}>
      {(row) => (
        <Switch>
          <Match when={row().kind === 'group-label' ? row() : undefined}>
            {(groupLabel) => (
              <div class="add-session-list-label" role="presentation">
                {(groupLabel() as Extract<ModelPickerRow, { kind: 'group-label' }>).text}
              </div>
            )}
          </Match>
          <Match when={row().kind === 'back' ? row() : undefined}>
            {(backRow) => (
              <Pressable
                class="add-session-row add-session-row-back"
                data-key={backRow().key}
                onClick={() => props.onBack()}
              >
                <span class="add-session-row-chevron" />
                <span class="add-session-row-name">
                  {(backRow() as Extract<ModelPickerRow, { kind: 'back' }>).label}
                </span>
              </Pressable>
            )}
          </Match>
          <Match when={row().kind === 'typed' ? row() : undefined}>
            {(typedRow) => (
              <Pressable
                class="add-session-row add-session-row-choice"
                data-key={typedRow().key}
                onClick={() => {
                  const picked = typedRow() as Extract<ModelPickerRow, { kind: 'typed' }>;
                  props.onPickTypedModel(picked.provider, picked.modelId);
                }}
              >
                <span class="add-session-row-name">
                  {(typedRow() as Extract<ModelPickerRow, { kind: 'typed' }>).label}
                </span>
                <span class="add-session-row-chevron" />
              </Pressable>
            )}
          </Match>
          <Match when={row().kind === 'model' ? row() : undefined}>
            {(modelRow) => (
              <Pressable
                class="add-session-row"
                role="option"
                aria-selected={(modelRow() as Extract<ModelPickerRow, { kind: 'model' }>).isPicked ? 'true' : 'false'}
                data-key={modelRow().key}
                onClick={() => {
                  const picked = modelRow() as Extract<ModelPickerRow, { kind: 'model' }>;
                  props.onPickModel(picked.provider, picked.modelId);
                }}
              >
                <span class="add-session-row-name">
                  {(modelRow() as Extract<ModelPickerRow, { kind: 'model' }>).label}
                </span>
                <Show when={(modelRow() as Extract<ModelPickerRow, { kind: 'model' }>).meta}>
                  {(meta) => <span class="add-session-row-meta">{meta()}</span>}
                </Show>
              </Pressable>
            )}
          </Match>
          <Match when={row().kind === 'effort' ? row() : undefined}>
            {(effortRow) => (
              <Pressable
                class="add-session-row"
                role="option"
                aria-selected={(effortRow() as Extract<ModelPickerRow, { kind: 'effort' }>).isPicked ? 'true' : 'false'}
                data-key={effortRow().key}
                onClick={() => {
                  const picked = effortRow() as Extract<ModelPickerRow, { kind: 'effort' }>;
                  props.onPickEffort(picked.effort);
                }}
              >
                <span class="add-session-row-name">
                  {(effortRow() as Extract<ModelPickerRow, { kind: 'effort' }>).label}
                </span>
              </Pressable>
            )}
          </Match>
        </Switch>
      )}
    </For>
  );
}
