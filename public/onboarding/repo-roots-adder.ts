import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el, markAsNotCredential } from '../dom-helpers.ts';
import { gitRepoCountText, withRepoRootsAdded } from './first-run-checklist-core.ts';
import { button } from '../ui/button.ts';

type RepoRootSuggestion = NonNullable<ServerMessageOf<'repo-roots-scanned'>['suggestions']>[number];
type GithubRepo = ServerMessageOf<'github-repos-listed'>['repos'][number];

let adderSequence = 0;

const CURRENT_ROOTS_UNREADABLE_MESSAGE = 'Could not read the current repository roots.';
const CLONE_REPLY_TIMEOUT_MS = 11 * 60_000;
const GITHUB_LIST_REPLY_TIMEOUT_MS = 90_000;
const MAX_VISIBLE_GITHUB_REPOS = 8;
const NO_GITHUB_LOGIN_HINT = 'Run gh auth login on the machine running Glimmervoid to list your repos.';

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

type RepoRootSource = 'typed' | 'suggested' | 'cloned-url' | 'cloned-github';

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

  const githubSection = el('div', 'repo-roots-adder-github');
  const githubLabel = el('label', 'repo-roots-adder-label', 'FROM GITHUB');
  const githubFilter = markAsNotCredential(el('input', 'dialog-input repo-roots-adder-input'));
  adderSequence += 1;
  githubFilter.id = `repo-roots-adder-github-filter-${adderSequence}`;
  githubLabel.htmlFor = githubFilter.id;
  githubFilter.type = 'text';
  githubFilter.placeholder = 'filter your repos';
  githubFilter.spellcheck = false;
  githubFilter.hidden = true;
  const githubList = el('ul', 'repo-roots-adder-list');
  const githubHint = el('p', 'repo-roots-adder-status');
  githubSection.append(githubLabel, githubFilter, githubList, githubHint);

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

  element.append(githubSection, cloneRow.label, cloneRow.row, cloneStatus, suggestionsSection, folderRow.label, folderRow.row, errorEl);

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
      githubHint.textContent = githubHintText;
      setBusy(false);
    }
  }

  async function cloneFromUrl(source: string, statusLine: HTMLElement): Promise<string | null> {
    statusLine.textContent = `Cloning ${source}. A large repository takes a few minutes.`;
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

  wireInputRow(cloneRow, (value) => { void runAction(() => cloneFromUrl(value, cloneStatus), 'cloned-url', cloneRow.input); });

  let githubRepos: GithubRepo[] = [];
  let githubHintText = '';
  let githubListState: 'unloaded' | 'loading' | 'loaded' = 'unloaded';

  function renderGithubRepos() {
    const filterText = githubFilter.value.trim().toLowerCase();
    const matchingRepos = githubRepos.filter((repo) => repo.fullName.toLowerCase().includes(filterText)).slice(0, MAX_VISIBLE_GITHUB_REPOS);
    githubList.textContent = '';
    for (const repo of matchingRepos) {
      const row = el('li', 'repo-roots-adder-suggestion');
      const cloneButton = button({ variant: 'secondary', label: 'Clone' });
      cloneButton.setAttribute('aria-label', `Clone ${repo.fullName}`);
      cloneButton.disabled = isBusy;
      cloneButton.addEventListener('click', () => { void runAction(() => cloneFromUrl(repo.cloneUrl, githubHint), 'cloned-github', null); });
      row.append(el('span', 'repo-roots-adder-path', repo.fullName), el('span', 'repo-roots-adder-count', repo.isPrivate ? 'private' : ''), cloneButton);
      githubList.append(row);
    }
  }

  function showGithubHint(text: string) {
    githubHintText = text;
    githubHint.textContent = text;
  }

  async function loadGithubRepos() {
    if (githubListState !== 'unloaded') return;
    githubListState = 'loading';
    const reply = await sendControlRequest('list-github-repos', {}, { timeoutMs: GITHUB_LIST_REPLY_TIMEOUT_MS }).catch((error: unknown) => errorText(error));
    githubListState = 'unloaded';
    if (typeof reply === 'string' || reply.type !== 'github-repos-listed') {
      showGithubHint(`Could not list your GitHub repositories: ${typeof reply === 'string' ? reply : 'the server gave no answer'}`);
      return;
    }
    if (reply.source === 'none') {
      showGithubHint(NO_GITHUB_LOGIN_HINT);
      return;
    }
    if (reply.error) {
      showGithubHint(reply.error);
      return;
    }
    githubListState = 'loaded';
    showGithubHint('');
    githubRepos = reply.repos;
    githubFilter.hidden = githubRepos.length === 0;
    if (githubRepos.length === 0) showGithubHint('No repositories found for this GitHub login.');
    renderGithubRepos();
  }

  githubFilter.addEventListener('input', renderGithubRepos);
  void loadGithubRepos();
  wireInputRow(folderRow, (value) => { void runAction(() => saveRepoRoots([value]), 'typed', folderRow.input); });

  function setSuggestions(suggestions: readonly RepoRootSuggestion[]) {
    void loadGithubRepos();
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
