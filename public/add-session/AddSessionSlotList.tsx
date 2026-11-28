import { For, Match, Show, Switch, createEffect } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { ModelProvider } from '#shared/contracts/agent-models.ts';
import type { RecentRow, ScannedProject } from '../add-session-core.ts';
import { ModelPickerRows } from '../chat/ModelPickerRows.tsx';
import type { ModelPickerRow } from '../chat/model-picker-core.ts';
import { paintAgentChoiceMark } from '../session-card/agent-mark.ts';
import { Pressable } from '../ui/Pressable.tsx';
import type { AccountSlotRow, AddSessionSlot, AgentSlotRow, GithubRepo, ProjectSlotRow } from './add-session-picker-core.ts';

interface AddSessionSlotListProps {
  openSlot: AddSessionSlot | null;
  agentRows: readonly AgentSlotRow[];
  accountRows: readonly AccountSlotRow[];
  modelRows: readonly ModelPickerRow[];
  projectRows: readonly ProjectSlotRow[];
  onPickAgent: (agentId: string) => void;
  onPickAccount: (accountValue: string) => void;
  onPickModel: (provider: ModelProvider, modelId: string) => void;
  onPickTypedModel: (provider: ModelProvider, modelId: string) => void;
  onPickEffort: (effort: string | null) => void;
  onBackToModels: () => void;
  onPickIssue: (project: ScannedProject, issueNumber: number) => void;
  onPickProject: (row: RecentRow) => void;
  onPickGithub: (repo: GithubRepo) => void;
  onPickChoice: (choice: 'workspace' | 'folder') => void;
}

function agentMarkRef(agentId: () => string, label: () => string) {
  let markElement: HTMLSpanElement | undefined;
  createEffect(
    () => [agentId(), label()] as const,
    ([id, text]) => {
      if (markElement) paintAgentChoiceMark(markElement, id, text);
    },
  );
  return (element: HTMLSpanElement) => {
    markElement = element;
    element.setAttribute('aria-hidden', 'true');
    paintAgentChoiceMark(element, agentId(), label());
  };
}

export function AddSessionSlotList(props: AddSessionSlotListProps): JSX.Element {
  return (
    <Switch>
      <Match when={props.openSlot === 'agent'}>
        <For each={props.agentRows} keyed={(row) => row.key}>
          {(row) => (
            <Pressable
              class="add-session-row"
              role="option"
              aria-selected={row().isPicked ? 'true' : 'false'}
              data-key={row().key}
              onClick={() => props.onPickAgent(row().id)}
            >
              <span class="agent-mark" ref={agentMarkRef(() => row().id, () => row().label)} />
              <span class="add-session-row-name">{row().label}</span>
            </Pressable>
          )}
        </For>
      </Match>
      <Match when={props.openSlot === 'account'}>
        <For each={props.accountRows} keyed={(row) => row.key}>
          {(row) => (
            <Pressable
              class="add-session-row"
              role="option"
              aria-selected={row().isPicked ? 'true' : 'false'}
              data-key={row().key}
              onClick={() => props.onPickAccount(row().value)}
            >
              <span class="add-session-row-name">{row().label}</span>
              <Show when={row().metaText}>
                {(meta) => <span class="add-session-row-meta">{meta()}</span>}
              </Show>
            </Pressable>
          )}
        </For>
      </Match>
      <Match when={props.openSlot === 'model'}>
        <ModelPickerRows
          rows={props.modelRows}
          onPickModel={props.onPickModel}
          onPickTypedModel={props.onPickTypedModel}
          onPickEffort={props.onPickEffort}
          onBack={props.onBackToModels}
        />
      </Match>
      <Match when={props.openSlot === 'project'}>
        <For each={props.projectRows} keyed={(row) => row.key}>
          {(row) => (
            <Switch>
              <Match when={row().kind === 'issue' ? row() : undefined}>
                {(issueRow) => (
                  <Pressable
                    class="add-session-row"
                    role="option"
                    aria-selected="false"
                    data-key={issueRow().key}
                    onClick={() => {
                      const picked = issueRow() as Extract<ProjectSlotRow, { kind: 'issue' }>;
                      props.onPickIssue(picked.project, picked.issueNumber);
                    }}
                  >
                    <span class="add-session-row-name">
                      {(issueRow() as Extract<ProjectSlotRow, { kind: 'issue' }>).name}
                    </span>
                  </Pressable>
                )}
              </Match>
              <Match when={row().kind === 'project' ? row() : undefined}>
                {(projectRow) => (
                  <Pressable
                    class="add-session-row"
                    role="option"
                    aria-selected={(projectRow() as Extract<ProjectSlotRow, { kind: 'project' }>).isPicked ? 'true' : 'false'}
                    data-key={projectRow().key}
                    onClick={() => {
                      const picked = projectRow() as Extract<ProjectSlotRow, { kind: 'project' }>;
                      props.onPickProject(picked.row);
                    }}
                  >
                    <span class="add-session-row-name">
                      {(projectRow() as Extract<ProjectSlotRow, { kind: 'project' }>).name}
                    </span>
                    <Show when={(projectRow() as Extract<ProjectSlotRow, { kind: 'project' }>).counts.length > 0}>
                      <span class="add-session-row-meta">
                        <For each={(projectRow() as Extract<ProjectSlotRow, { kind: 'project' }>).counts}>
                          {(badge) => (
                            <span class="add-session-row-count" data-tone={badge.tone}>
                              {`${badge.count} ${badge.label}`}
                            </span>
                          )}
                        </For>
                      </span>
                    </Show>
                    <Show when={(projectRow() as Extract<ProjectSlotRow, { kind: 'project' }>).ageText}>
                      {(age) => <span class="add-session-row-meta">{age()}</span>}
                    </Show>
                  </Pressable>
                )}
              </Match>
              <Match when={row().kind === 'choice' ? row() : undefined}>
                {(choiceRow) => (
                  <Pressable
                    class="add-session-row add-session-row-choice"
                    data-key={choiceRow().key}
                    onClick={() => {
                      const picked = choiceRow() as Extract<ProjectSlotRow, { kind: 'choice' }>;
                      props.onPickChoice(picked.choice);
                    }}
                  >
                    <span class="add-session-row-name">
                      {(choiceRow() as Extract<ProjectSlotRow, { kind: 'choice' }>).label}
                    </span>
                    <span class="add-session-row-chevron" />
                  </Pressable>
                )}
              </Match>
              <Match when={row().kind === 'group-label' ? row() : undefined}>
                {(groupRow) => (
                  <div class="add-session-list-label" role="presentation">
                    {(groupRow() as Extract<ProjectSlotRow, { kind: 'group-label' }>).text}
                  </div>
                )}
              </Match>
              <Match when={row().kind === 'github' ? row() : undefined}>
                {(githubRow) => (
                  <Pressable
                    class="add-session-row"
                    role="option"
                    aria-selected={(githubRow() as Extract<ProjectSlotRow, { kind: 'github' }>).isPicked ? 'true' : 'false'}
                    data-key={githubRow().key}
                    onClick={() => {
                      const picked = githubRow() as Extract<ProjectSlotRow, { kind: 'github' }>;
                      props.onPickGithub(picked.repo);
                    }}
                  >
                    <span class="add-session-row-name">
                      {(githubRow() as Extract<ProjectSlotRow, { kind: 'github' }>).name}
                    </span>
                    <Show when={(githubRow() as Extract<ProjectSlotRow, { kind: 'github' }>).metaText !== ''}>
                      <span class="add-session-row-meta">
                        {(githubRow() as Extract<ProjectSlotRow, { kind: 'github' }>).metaText}
                      </span>
                    </Show>
                  </Pressable>
                )}
              </Match>
            </Switch>
          )}
        </For>
      </Match>
    </Switch>
  );
}
