import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { gitRepoCountText, withRepoRootAdded } from './first-run-checklist-core.ts';

type RepoRootSuggestion = NonNullable<ServerMessageOf<'repo-roots-scanned'>['suggestions']>[number];

let adderSequence = 0;

const CURRENT_ROOTS_UNREADABLE_MESSAGE = 'Could not read the current repository roots.';

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

async function saveRepoRoot(addedRoot: string): Promise<string | null> {
  const settingsReply = await sendControlRequest('get-settings', {});
  if (settingsReply.type !== 'settings') return CURRENT_ROOTS_UNREADABLE_MESSAGE;
  const configuredRoots = settingsReply.settings.repoRoots;
  if (!isStringList(configuredRoots)) return CURRENT_ROOTS_UNREADABLE_MESSAGE;
  const nextRoots = withRepoRootAdded(configuredRoots, addedRoot);
  if (!nextRoots) return null;
  const reply = await sendControlRequest('update-settings', { settings: { repoRoots: nextRoots } });
  if (reply.type === 'settings-error') return reply.message;
  return null;
}

type RepoRootSource = 'typed' | 'suggested';

export function createRepoRootsAdder({ onAdded }: { onAdded: (source: RepoRootSource) => void }) {
  adderSequence += 1;
  const typedInputId = `repo-roots-adder-path-${adderSequence}`;
  const element = el('div', 'repo-roots-adder');

  const suggestionsSection = el('div', 'repo-roots-adder-found');
  const suggestionsHeading = el('span', 'repo-roots-adder-label', 'FOUND ON THIS MACHINE');
  const suggestionsList = el('ul', 'repo-roots-adder-list');
  suggestionsSection.append(suggestionsHeading, suggestionsList);
  suggestionsSection.hidden = true;

  const typedLabel = el('label', 'repo-roots-adder-label', 'TYPE A PATH');
  typedLabel.htmlFor = typedInputId;
  const typedRow = el('div', 'repo-roots-adder-row');
  const typedInput = el('input', 'dialog-input repo-roots-adder-input');
  typedInput.id = typedInputId;
  typedInput.type = 'text';
  typedInput.placeholder = '~/src';
  typedInput.autocomplete = 'off';
  typedInput.spellcheck = false;
  const typedAddButton = el('button', 'btn-dialog btn-dialog-cancel', 'Add');
  typedAddButton.type = 'button';
  typedAddButton.disabled = true;
  typedRow.append(typedInput, typedAddButton);

  const errorEl = el('p', 'repo-roots-adder-error');
  errorEl.setAttribute('role', 'alert');

  element.append(suggestionsSection, typedLabel, typedRow, errorEl);

  let isSaving = false;
  function setSaving(saving: boolean) {
    isSaving = saving;
    for (const button of element.querySelectorAll<HTMLButtonElement>('button')) button.disabled = saving;
    if (!saving) typedAddButton.disabled = typedInput.value.trim() === '';
  }

  async function addRoot(addedRoot: string, source: RepoRootSource) {
    if (isSaving) return;
    setSaving(true);
    errorEl.textContent = '';
    try {
      const saveError = await saveRepoRoot(addedRoot);
      if (saveError) {
        errorEl.textContent = saveError;
        return;
      }
      typedInput.value = '';
      onAdded(source);
    } catch (error) {
      errorEl.textContent = `Could not save the folder: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      setSaving(false);
    }
  }

  typedInput.addEventListener('input', () => {
    typedAddButton.disabled = isSaving || typedInput.value.trim() === '';
  });
  typedInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || typedInput.value.trim() === '') return;
    event.preventDefault();
    void addRoot(typedInput.value.trim(), 'typed');
  });
  typedAddButton.addEventListener('click', () => { void addRoot(typedInput.value.trim(), 'typed'); });

  function setSuggestions(suggestions: readonly RepoRootSuggestion[]) {
    suggestionsList.textContent = '';
    for (const suggestion of suggestions) {
      const row = el('li', 'repo-roots-adder-suggestion');
      const addButton = el('button', 'btn-dialog btn-dialog-cancel', 'Add');
      addButton.type = 'button';
      addButton.setAttribute('aria-label', `Add ${suggestion.label}`);
      addButton.addEventListener('click', () => { void addRoot(suggestion.path, 'suggested'); });
      row.append(
        el('span', 'repo-roots-adder-path', suggestion.label),
        el('span', 'repo-roots-adder-count', gitRepoCountText(suggestion.gitRepoCount)),
        addButton,
      );
      suggestionsList.append(row);
    }
    suggestionsSection.hidden = suggestions.length === 0;
    typedLabel.textContent = suggestions.length > 0 ? 'OR TYPE A PATH' : 'TYPE A PATH';
  }

  return { element, setSuggestions };
}

