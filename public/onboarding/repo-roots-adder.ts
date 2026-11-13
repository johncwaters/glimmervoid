import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el, markAsNotCredential } from '../dom-helpers.ts';
import { gitRepoCountText, withRepoRootsAdded } from './first-run-checklist-core.ts';
import { button } from '../ui/button.ts';

type RepoRootSuggestion = NonNullable<ServerMessageOf<'repo-roots-scanned'>['suggestions']>[number];

let adderSequence = 0;

const CURRENT_ROOTS_UNREADABLE_MESSAGE = 'Could not read the current repository roots.';
const CLONE_REPLY_TIMEOUT_MS = 11 * 60_000;

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export async function saveRepoRoots(addedRoots: readonly string[]): Promise<string | null> {
  const settingsReply = await sendControlRequest('get-settings', {});
  if (settingsReply.type !== 'settings') return CURRENT_ROOTS_UNREADABLE_MESSAGE;
  const configuredRoots = settingsReply.settings.repoRoots;
  if (!isStringList(configuredRoots)) return CURRENT_ROOTS_UNREADABLE_MESSAGE;
  const nextRoots = withRepoRootsAdded(configuredRoots, addedRoots);
  if (!nextRoots) return null;
  const reply = await sendControlRequest('update-settings', { settings: { repoRoots: nextRoots } });
  if (reply.type === 'settings-error') return reply.message;
  return null;
}

type RepoRootSource = 'typed' | 'suggested' | 'cloned-url';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildInputRow(labelText: string, placeholder: string, actionLabel: string) {
  adderSequence += 1;
  const inputId = `repo-roots-adder-input-${adderSequence}`;
  const label = el('label', 'repo-roots-adder-label', labelText);
  label.htmlFor = inputId;
  const row = el('div', 'repo-roots-adder-row');
  const input = markAsNotCredential(el('input', 'dialog-input repo-roots-adder-input'));
  input.id = inputId;
  input.type = 'text';
  input.placeholder = placeholder;
  input.spellcheck = false;
  const actionButton = button({ variant: 'secondary', label: actionLabel });
  actionButton.disabled = true;
  row.append(input, actionButton);
  return { label, row, input, actionButton };
}

export function createRepoRootsAdder({ onAdded }: { onAdded: (source: RepoRootSource) => void }) {
  const element = el('div', 'repo-roots-adder');

  const cloneRow = buildInputRow('PASTE A REPO URL', 'https://github.com/owner/repo', 'Clone');
  const cloneStatus = el('p', 'repo-roots-adder-status');
  cloneStatus.setAttribute('role', 'status');

  const suggestionsSection = el('div', 'repo-roots-adder-found');
  const suggestionsHeading = el('span', 'repo-roots-adder-label', 'FOUND ON THIS MACHINE');
  const suggestionsList = el('ul', 'repo-roots-adder-list');
  suggestionsSection.append(suggestionsHeading, suggestionsList);
  suggestionsSection.hidden = true;

  const folderRow = buildInputRow('OPEN A FOLDER', '/path/to/your/checkouts', 'Add');

  const errorEl = el('p', 'repo-roots-adder-error');
  errorEl.setAttribute('role', 'alert');

  element.append(cloneRow.label, cloneRow.row, cloneStatus, suggestionsSection, folderRow.label, folderRow.row, errorEl);

  let isBusy = false;
  function setBusy(busy: boolean) {
    isBusy = busy;
    for (const actionButton of element.querySelectorAll<HTMLButtonElement>('button')) actionButton.disabled = busy;
    if (busy) return;
    cloneRow.actionButton.disabled = cloneRow.input.value.trim() === '';
    folderRow.actionButton.disabled = folderRow.input.value.trim() === '';
  }

  async function runAction(action: () => Promise<string | null>, source: RepoRootSource, clearedInput: HTMLInputElement | null) {
    if (isBusy) return;
    setBusy(true);
    errorEl.textContent = '';
    try {
      const failure = await action();
      if (failure) {
        errorEl.textContent = failure;
        return;
      }
      if (clearedInput) clearedInput.value = '';
      onAdded(source);
    } catch (error) {
      errorEl.textContent = `Could not finish: ${errorText(error)}`;
    } finally {
      cloneStatus.textContent = '';
      setBusy(false);
    }
  }

  async function cloneFromUrl(source: string): Promise<string | null> {
    cloneStatus.textContent = `Cloning ${source}. A large repository takes a few minutes.`;
    const reply = await sendControlRequest('clone-repository', { source }, { timeoutMs: CLONE_REPLY_TIMEOUT_MS });
    if (reply.type !== 'repository-cloned') return 'The server gave no answer to the clone.';
    if (!reply.ok) return reply.error ?? 'The clone failed.';
    return null;
  }

  function wireInputRow(inputRow: ReturnType<typeof buildInputRow>, act: (value: string) => void) {
    inputRow.input.addEventListener('input', () => {
      inputRow.actionButton.disabled = isBusy || inputRow.input.value.trim() === '';
    });
    inputRow.input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || inputRow.input.value.trim() === '') return;
      event.preventDefault();
      act(inputRow.input.value.trim());
    });
    inputRow.actionButton.addEventListener('click', () => act(inputRow.input.value.trim()));
  }

  wireInputRow(cloneRow, (value) => { void runAction(() => cloneFromUrl(value), 'cloned-url', cloneRow.input); });
  wireInputRow(folderRow, (value) => { void runAction(() => saveRepoRoots([value]), 'typed', folderRow.input); });

  function setSuggestions(suggestions: readonly RepoRootSuggestion[]) {
    suggestionsList.textContent = '';
    for (const suggestion of suggestions) {
      const row = el('li', 'repo-roots-adder-suggestion');
      const addButton = button({ variant: 'secondary', label: 'Add' });
      addButton.setAttribute('aria-label', `Add ${suggestion.label}`);
      addButton.disabled = isBusy;
      addButton.addEventListener('click', () => { void runAction(() => saveRepoRoots([suggestion.path]), 'suggested', null); });
      row.append(
        el('span', 'repo-roots-adder-path', suggestion.label),
        el('span', 'repo-roots-adder-count', gitRepoCountText(suggestion.gitRepoCount)),
        addButton,
      );
      suggestionsList.append(row);
    }
    suggestionsSection.hidden = suggestions.length === 0;
  }

  return { element, setSuggestions };
}
