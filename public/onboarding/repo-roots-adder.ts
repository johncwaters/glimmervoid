import type { ServerMessageOf } from '#shared/contracts/control-messages.ts';
import { sendControlRequest } from '../control-ws.ts';
import { el, markAsNotCredential } from '../dom-helpers.ts';
import { gitRepoCountText, withRepoRootsAdded } from './first-run-checklist-core.ts';
import { button } from '../ui/button.ts';
import { buildGithubConnectSection } from '../secrets/github-connect.ts';
import { githubRepoListHintOf } from '../secrets/github-connect-core.ts';
import { MAX_CLONE_SOURCES_PER_REQUEST } from '#shared/contracts/control/settings-messages.ts';
import type { GithubConnection } from '#shared/contracts/watcher-link.ts';
import { applyCloneJobs, cloneJobOf, cloneJobStatusText, clonedSources, hasUnsettledCloneJobs, isCloneJobUnsettled, onCloneJobsChanged } from './clone-jobs.ts';

type RepoRootSuggestion = NonNullable<ServerMessageOf<'repo-roots-scanned'>['suggestions']>[number];
type GithubRepo = ServerMessageOf<'github-repos-listed'>['repos'][number];

let adderSequence = 0;

const CURRENT_ROOTS_UNREADABLE_MESSAGE = 'Could not read the current repository roots.';
const GITHUB_LIST_REPLY_TIMEOUT_MS = 90_000;
const FOLDER_COMPLETION_DELAY_MS = 150;
const GITHUB_GRANT_WAIT_ATTEMPTS = 6;
const GITHUB_GRANT_WAIT_MS = 5_000;
const TRAILING_SEPARATORS_RE = /(.)[\\/]+$/;

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

function buildInputRow(placeholder: string, actionLabel: string) {
  adderSequence += 1;
  const inputId = `repo-roots-adder-input-${adderSequence}`;
  const row = el('div', 'repo-roots-adder-row');
  const input = markAsNotCredential(el('input', 'dialog-input repo-roots-adder-input'));
  input.id = inputId;
  input.type = 'text';
  input.placeholder = placeholder;
  input.spellcheck = false;
  const actionButton = button({ variant: 'secondary', label: actionLabel });
  actionButton.disabled = true;
  row.append(input, actionButton);
  return { row, input, actionButton };
}

export function createRepoRootsAdder({ onAdded }: { onAdded: (source: RepoRootSource) => void }) {
  const element = el('div', 'repo-roots-adder');

  const githubSection = el('div', 'repo-roots-adder-github');
  const githubLabel = el('span', 'repo-roots-adder-label', 'GITHUB');
  const githubFilter = markAsNotCredential(el('input', 'dialog-input repo-roots-adder-input'));
  adderSequence += 1;
  githubFilter.id = `repo-roots-adder-github-filter-${adderSequence}`;
  githubFilter.setAttribute('aria-label', 'Filter your GitHub repositories');
  githubFilter.type = 'text';
  githubFilter.placeholder = 'filter your repos';
  githubFilter.spellcheck = false;
  githubFilter.hidden = true;
  const githubList = el('ul', 'repo-roots-adder-list');
  const githubHint = el('p', 'repo-roots-adder-status');

  const cloneRow = buildInputRow('https://github.com/owner/repo', 'Clone');
  cloneRow.input.setAttribute('aria-label', 'Repository URL to clone');
  const cloneStatus = el('p', 'repo-roots-adder-status');
  cloneStatus.setAttribute('role', 'status');
  const cloneCancelButton = button({ variant: 'quiet', label: 'Cancel' });
  cloneCancelButton.setAttribute('aria-label', 'Cancel the clone of the pasted URL');
  const cloneProgressRow = el('div', 'repo-roots-adder-row repo-roots-adder-url-progress');
  cloneProgressRow.append(cloneStatus, cloneCancelButton);
  cloneProgressRow.hidden = true;

  const selectBar = el('div', 'repo-roots-adder-select-bar');
  const selectAllLabel = el('label', 'repo-roots-adder-select-all');
  const selectAllBox = el('input', 'settings-view-checkbox');
  selectAllBox.type = 'checkbox';
  selectAllLabel.append(selectAllBox, el('span', null, 'Select all'));
  const selectionStatus = el('span', 'repo-roots-adder-count');
  selectionStatus.setAttribute('role', 'status');
  const cloneSelectedButton = button({ variant: 'secondary', label: 'Clone selected' });
  cloneSelectedButton.disabled = true;
  selectBar.append(selectAllLabel, selectionStatus, cloneSelectedButton);
  selectBar.hidden = true;

  const suggestionsSection = el('div', 'repo-roots-adder-found');
  const suggestionsHeading = el('span', 'repo-roots-adder-label', 'FOUND ON THIS MACHINE');
  const suggestionsList = el('ul', 'repo-roots-adder-list');
  suggestionsSection.append(suggestionsHeading, suggestionsList);
  suggestionsSection.hidden = true;

  const folderSection = el('div', 'repo-roots-adder-folder');
  const folderRow = buildInputRow('~/', 'Add');
  const folderLabel = el('label', 'repo-roots-adder-label', 'OPEN A FOLDER');
  folderLabel.htmlFor = folderRow.input.id;
  folderSection.append(folderLabel, folderRow.row);
  const folderCompletions = el('datalist', 'repo-roots-adder-completions');
  folderCompletions.id = `${folderRow.input.id}-completions`;
  folderRow.input.setAttribute('list', folderCompletions.id);
  folderRow.row.append(folderCompletions);

  const errorEl = el('p', 'repo-roots-adder-error');
  errorEl.setAttribute('role', 'alert');

  let githubConnection: GithubConnection | null = null;
  let listedForConnection: string | null = null;
  const githubConnectSection = buildGithubConnectSection({ layout: 'stacked', isHiddenWithoutConnect: true, onConnectionChange: noteGithubConnection });

  githubSection.append(githubLabel, githubConnectSection, githubFilter, selectBar, githubList, githubHint, cloneRow.row, cloneProgressRow);
  element.append(githubSection, suggestionsSection, folderSection, errorEl);

  function noteGithubConnection(connection: GithubConnection | null) {
    if (connection === null && githubConnection !== null) return;
    githubConnection = connection;
    const reachedAccounts = connection?.state === 'connected' ? `${connection.login}: ${connection.accounts.join(',')}` : connection?.state ?? '';
    if (reachedAccounts === listedForConnection) return;
    listedForConnection = reachedAccounts;
    forgetGithubRepos();
    void loadGithubReposOnceGranted(connection?.state === 'connected' ? GITHUB_GRANT_WAIT_ATTEMPTS : 1);
  }

  let isBusy = false;
  function setBusy(busy: boolean) {
    isBusy = busy;
    for (const actionButton of element.querySelectorAll<HTMLButtonElement>('.repo-roots-adder-folder button, .repo-roots-adder-found button')) actionButton.disabled = busy;
    if (busy) return;
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
      setBusy(false);
    }
  }

  const cloneKindBySource = new Map<string, RepoRootSource>();
  const seenClonedSources = new Set(clonedSources());
  let finishedCloneKind: RepoRootSource | null = null;
  let pastedCloneSource: string | null = null;

  async function startClones(sources: readonly string[], cloneKind: RepoRootSource): Promise<boolean> {
    errorEl.textContent = '';
    for (const source of sources) cloneKindBySource.set(source, cloneKind);
    const reply = await sendControlRequest('start-repository-clones', { sources: [...sources] }).catch((error: unknown) => errorText(error));
    if (typeof reply === 'string' || reply.type !== 'repository-clones') {
      errorEl.textContent = `Could not start the clone: ${typeof reply === 'string' ? reply : 'the server gave no answer'}`;
      return false;
    }
    applyCloneJobs(reply.jobs);
    errorEl.textContent = reply.error ?? '';
    return !reply.error;
  }

  function cancelClone(source: string) {
    void sendControlRequest('cancel-repository-clone', { source })
      .then((reply) => { if (reply.type === 'repository-clones') applyCloneJobs(reply.jobs); })
      .catch((error: unknown) => { errorEl.textContent = `Could not cancel the clone: ${errorText(error)}`; });
  }

  async function clonePastedUrl(source: string) {
    pastedCloneSource = source;
    const isStarted = await startClones([source], 'cloned-url');
    if (isStarted) cloneRow.input.value = '';
    cloneRow.actionButton.disabled = cloneRow.input.value.trim() === '';
    paintCloneJobs();
  }

  cloneCancelButton.addEventListener('click', () => { if (pastedCloneSource !== null) cancelClone(pastedCloneSource); });

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

  wireInputRow(cloneRow, (value) => { void clonePastedUrl(value); });

  let githubRepos: GithubRepo[] = [];
  let githubListState: 'unloaded' | 'loading' | 'loaded' = 'unloaded';

  type GithubRepoRow = { repo: GithubRepo; selectBox: HTMLInputElement; progress: HTMLElement; status: HTMLElement; cancelButton: HTMLButtonElement; cloneButton: HTMLButtonElement };
  let githubRepoRows: GithubRepoRow[] = [];
  const selectedSources = new Set<string>();

  function canSelect(repo: GithubRepo): boolean {
    const job = cloneJobOf(repo.cloneUrl);
    return !isCloneJobUnsettled(job) && job?.state !== 'done';
  }

  function paintRepoRow({ repo, selectBox, progress, status, cancelButton, cloneButton }: GithubRepoRow) {
    const job = cloneJobOf(repo.cloneUrl);
    const isSelectable = canSelect(repo);
    if (!isSelectable) selectedSources.delete(repo.cloneUrl);
    selectBox.disabled = !isSelectable;
    selectBox.checked = selectedSources.has(repo.cloneUrl);
    progress.hidden = job === null;
    status.textContent = cloneJobStatusText(job);
    status.dataset.state = job?.state ?? '';
    cancelButton.hidden = !isCloneJobUnsettled(job);
    cloneButton.disabled = !isSelectable;
  }

  function paintSelection() {
    const selectableRows = githubRepoRows.filter((row) => canSelect(row.repo));
    const selectedRowCount = selectableRows.filter((row) => selectedSources.has(row.repo.cloneUrl)).length;
    selectAllBox.disabled = selectableRows.length === 0;
    selectAllBox.checked = selectableRows.length > 0 && selectedRowCount === selectableRows.length;
    selectAllBox.indeterminate = selectedRowCount > 0 && selectedRowCount < selectableRows.length;
    selectionStatus.textContent = selectedSources.size === 0 ? '' : `${selectedSources.size} selected`;
    cloneSelectedButton.disabled = selectedSources.size === 0;
  }

  function paintCloneJobs() {
    for (const row of githubRepoRows) paintRepoRow(row);
    paintSelection();
    const pastedJob = pastedCloneSource === null ? null : cloneJobOf(pastedCloneSource);
    cloneStatus.textContent = pastedJob === null ? '' : `${pastedJob.name}: ${cloneJobStatusText(pastedJob)}`;
    cloneCancelButton.hidden = !isCloneJobUnsettled(pastedJob);
    cloneProgressRow.hidden = pastedJob === null;
  }

  function noteCloneJobs() {
    paintCloneJobs();
    for (const source of clonedSources()) {
      if (seenClonedSources.has(source)) continue;
      seenClonedSources.add(source);
      finishedCloneKind ??= cloneKindBySource.get(source) ?? 'cloned-github';
    }
    if (finishedCloneKind === null || hasUnsettledCloneJobs()) return;
    const addedKind = finishedCloneKind;
    finishedCloneKind = null;
    onAdded(addedKind);
  }

  let hasBeenMounted = false;
  const stopWatchingCloneJobs = onCloneJobsChanged(() => {
    hasBeenMounted ||= element.isConnected;
    if (element.isConnected) noteCloneJobs();
    if (hasBeenMounted && !element.isConnected) stopWatchingCloneJobs();
  });

  function buildRepoRow(repo: GithubRepo): GithubRepoRow & { element: HTMLElement } {
    const row = el('li', 'repo-roots-adder-repo');
    const selectBox = el('input', 'settings-view-checkbox');
    selectBox.type = 'checkbox';
    selectBox.setAttribute('aria-label', `Select ${repo.fullName}`);
    selectBox.addEventListener('change', () => {
      if (selectBox.checked) selectedSources.add(repo.cloneUrl);
      if (!selectBox.checked) selectedSources.delete(repo.cloneUrl);
      paintSelection();
    });
    const status = el('span', 'repo-roots-adder-repo-status');
    const cancelButton = button({ variant: 'quiet', label: 'Cancel' });
    cancelButton.setAttribute('aria-label', `Cancel the clone of ${repo.fullName}`);
    cancelButton.addEventListener('click', () => cancelClone(repo.cloneUrl));
    const cloneButton = button({ variant: 'secondary', label: 'Clone' });
    cloneButton.setAttribute('aria-label', `Clone ${repo.fullName}`);
    cloneButton.addEventListener('click', () => { void startClones([repo.cloneUrl], 'cloned-github'); });
    const cloneAction = el('span', 'repo-roots-adder-repo-action');
    cloneAction.append(cloneButton);
    const progress = el('div', 'repo-roots-adder-repo-progress');
    progress.append(status, cancelButton);
    row.append(selectBox, el('span', 'repo-roots-adder-path', repo.fullName), el('span', 'repo-roots-adder-count', repo.isPrivate ? 'private' : ''), cloneAction, progress);
    return { element: row, repo, selectBox, progress, status, cancelButton, cloneButton };
  }

  function renderGithubRepos() {
    const filterText = githubFilter.value.trim().toLowerCase();
    const builtRows = githubRepos.filter((repo) => repo.fullName.toLowerCase().includes(filterText)).map(buildRepoRow);
    githubRepoRows = builtRows;
    githubList.replaceChildren(...builtRows.map((row) => row.element));
    selectBar.hidden = githubRepos.length === 0;
    paintCloneJobs();
  }

  selectAllBox.addEventListener('change', () => {
    for (const { repo } of githubRepoRows.filter((row) => canSelect(row.repo))) {
      if (selectAllBox.checked) selectedSources.add(repo.cloneUrl);
      if (!selectAllBox.checked) selectedSources.delete(repo.cloneUrl);
    }
    paintCloneJobs();
  });
  async function cloneSelected() {
    const sources = [...selectedSources];
    for (let batchStart = 0; batchStart < sources.length; batchStart += MAX_CLONE_SOURCES_PER_REQUEST) {
      const batch = sources.slice(batchStart, batchStart + MAX_CLONE_SOURCES_PER_REQUEST);
      const isStarted = await startClones(batch, 'cloned-github');
      if (!isStarted) break;
      for (const source of batch) selectedSources.delete(source);
    }
    paintCloneJobs();
  }
  cloneSelectedButton.addEventListener('click', () => { void cloneSelected(); });

  function forgetGithubRepos() {
    if (githubListState === 'loading') return;
    githubListState = 'unloaded';
    githubRepos = [];
    githubFilter.hidden = true;
    renderGithubRepos();
  }

  function showGithubHint(text: string) {
    githubHint.textContent = text;
  }

  async function loadGithubReposOnceGranted(attemptsLeft: number) {
    await loadGithubRepos();
    if (githubListState === 'loaded' || attemptsLeft <= 1) return;
    setTimeout(() => {
      if (element.isConnected) void loadGithubReposOnceGranted(attemptsLeft - 1);
    }, GITHUB_GRANT_WAIT_MS);
  }

  async function loadGithubRepos() {
    if (githubListState !== 'unloaded' || listedForConnection === null) return;
    githubListState = 'loading';
    const reply = await sendControlRequest('list-github-repos', {}, { timeoutMs: GITHUB_LIST_REPLY_TIMEOUT_MS }).catch((error: unknown) => errorText(error));
    githubListState = 'unloaded';
    if (typeof reply === 'string' || reply.type !== 'github-repos-listed') {
      showGithubHint(`Could not list your GitHub repositories: ${typeof reply === 'string' ? reply : 'the server gave no answer'}`);
      return;
    }
    if (reply.source === 'none') {
      showGithubHint(githubRepoListHintOf(githubConnection));
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
  wireInputRow(folderRow, (value) => { void runAction(() => saveRepoRoots([value.replace(TRAILING_SEPARATORS_RE, '$1')]), 'typed', folderRow.input); });

  let folderCompletionTimer: ReturnType<typeof setTimeout> | null = null;
  let latestFolderQuery = '';

  async function completeFolder(query: string) {
    latestFolderQuery = query;
    const reply = await sendControlRequest('list-folders', { query }).catch(() => null);
    if (query !== latestFolderQuery || reply?.type !== 'folders-listed') return;
    folderCompletions.textContent = '';
    for (const entry of reply.entries) {
      const option = el('option');
      option.value = entry.path;
      if (entry.isGit) option.label = 'git checkout';
      folderCompletions.append(option);
    }
  }

  folderRow.input.addEventListener('input', () => {
    if (folderCompletionTimer) clearTimeout(folderCompletionTimer);
    folderCompletionTimer = setTimeout(() => { void completeFolder(folderRow.input.value); }, FOLDER_COMPLETION_DELAY_MS);
  });
  folderRow.input.addEventListener('focus', () => { if (folderRow.input.value === '') void completeFolder(''); });

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
