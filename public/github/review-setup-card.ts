import type { GithubTeam, OperatorActionOf } from '#shared/contracts/control-messages.ts';
import type { GithubConnection } from '#shared/contracts/watcher-link.ts';
import { button } from '../ui/button.ts';
import { createActionStatus, DEFAULT_REPLY_TIMEOUT_MS, requestFailureText } from '../action-status.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { el, markAsNotCredential } from '../dom-helpers.ts';
import { buildCommandRow, buildSetupStep } from '../onboarding/setup-step.ts';
import { buildGithubConnectSection, isConnectOffered } from '../secrets/github-connect.ts';
import { createSettingsLink } from '../settings/settings-link.ts';
import { applySettingsBroadcast, subscribeSettings } from '../settings/settings-store.ts';
import { TEAM_REVIEW_SETTINGS_SECTION_ID, TEAM_REVIEW_SETTINGS_SETTING_ID } from './team-review-view-core.ts';
import { decideReviewSetupSteps, orgToSave, teamOptionsOf, teamsToSave } from './review-setup-core.ts';
import { hasLaneReadToken, laneReadTokenStepBody } from './lane-read-token-step.ts';

const GH_SIGN_IN_COMMAND = 'gh auth login';

interface GithubTeamsListing { viewer: string | null; teams: GithubTeam[]; orgs: string[]; error: string | null }

function reportReviewSetupAction(action: OperatorActionOf<'onboarding'>): void {
  sendControlMsg({ type: 'dashboard-telemetry', event: 'operator_action', properties: { surface: 'onboarding', action } });
}

function typedTextInput(inputId: string, placeholder: string): HTMLInputElement {
  const input = markAsNotCredential(el('input', 'dialog-input repo-roots-adder-input'));
  input.id = inputId;
  input.type = 'text';
  input.placeholder = placeholder;
  input.spellcheck = false;
  return input;
}

function githubStepBadgeOf(connection: GithubConnection): string {
  if (!isConnectOffered(connection)) return 'NOT SIGNED IN';
  if (connection.state === 'connected') return 'NOT READ YET';
  return 'NOT CONNECTED';
}

export function createReviewSetupCard() {
  const element = el('section', 'first-run-checklist review-setup');
  element.setAttribute('aria-labelledby', 'review-setup-title');
  const heading = el('h2', 'first-run-title', 'Connect GitHub to see pull requests');
  heading.id = 'review-setup-title';
  const stepsList = el('ol', 'first-run-steps');
  const loadStatus = createActionStatus();
  const foot = el('p', 'first-run-step-hint review-setup-foot', 'Team review drafts a review of each pull request that requests your review or your team\'s. Nothing posts until you choose Approve or Comment. ');
  foot.append(createSettingsLink(TEAM_REVIEW_SETTINGS_SECTION_ID, TEAM_REVIEW_SETTINGS_SETTING_ID, 'All Reviews settings'));
  element.append(el('span', 'first-run-eyebrow', 'SET UP REVIEWS'), heading, stepsList, loadStatus.element, foot);

  let listing: GithubTeamsListing = { viewer: null, teams: [], orgs: [], error: null };
  let selectedOrg = '';
  let loadSequence = 0;
  let checkAgainButton: HTMLButtonElement | null = null;
  const checkedEntries = new Set<string>();
  let isGithubConnectOffered = false;
  let githubStepBadge = 'NOT SIGNED IN';
  let seenGithubConnection: string | null = null;
  const githubConnectSection = buildGithubConnectSection({ layout: 'stacked', isHiddenWithoutConnect: true, onConnectionChange: noteGithubConnection });

  function noteGithubConnection(connection: GithubConnection | null): void {
    if (connection === null) return;
    const githubConnection = connection.state === 'connected' ? `connected ${connection.login}` : connection.state;
    if (githubConnection === seenGithubConnection) return;
    const isFirstAnswer = seenGithubConnection === null;
    seenGithubConnection = githubConnection;
    isGithubConnectOffered = isConnectOffered(connection);
    githubStepBadge = githubStepBadgeOf(connection);
    render();
    if (!isFirstAnswer) void load();
  }

  function githubStepBody(): HTMLElement[] {
    const actions = el('div', 'first-run-step-actions');
    checkAgainButton = button({ variant: 'secondary', label: 'Check again', onClick: () => {
      reportReviewSetupAction('check-github-again');
      void load();
    } });
    actions.append(checkAgainButton);
    if (isGithubConnectOffered) return [githubConnectSection, actions];
    return [
      githubConnectSection,
      el('p', 'first-run-step-text', 'The GitHub CLI is not signed in on the machine running Glimmervoid. Sign in there, then check again.'),
      buildCommandRow(GH_SIGN_IN_COMMAND),
      actions,
    ];
  }

  function teamCheckbox(entry: string, label: string): HTMLElement {
    const row = el('label', 'review-setup-team');
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.checked = checkedEntries.has(entry);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) checkedEntries.add(entry);
      if (!checkbox.checked) checkedEntries.delete(entry);
    });
    row.append(checkbox, el('span', 'review-setup-team-entry', entry), el('span', 'review-setup-team-name', label));
    return row;
  }

  function listedTeamsElements(): HTMLElement[] {
    if (listing.error) return [el('p', 'first-run-step-hint', `${listing.error} Type a team below instead.`)];
    if (listing.teams.length === 0) return [el('p', 'first-run-step-hint', 'GitHub lists no teams for you. Type one below, or review only requests to you.')];
    const list = el('div', 'review-setup-teams');
    list.append(...teamOptionsOf(listing.teams).map((option) => teamCheckbox(option.entry, option.label)));
    return [el('span', 'repo-roots-adder-label', 'YOUR GITHUB TEAMS'), list];
  }

  function teamsStepBody(): HTMLElement[] {
    const typedInputId = 'review-setup-typed-team';
    const typedLabel = el('label', 'repo-roots-adder-label', listing.teams.length > 0 ? 'OR TYPE A TEAM' : 'TYPE A TEAM');
    typedLabel.htmlFor = typedInputId;
    const typedInput = typedTextInput(typedInputId, 'org/team-slug');
    const actions = el('div', 'first-run-step-actions');
    const saveButton = button({ variant: 'primary', label: 'Save teams' });
    const saveStatus = createActionStatus();
    saveButton.addEventListener('click', () => { void saveTeams(typedInput.value, saveButton, saveStatus); });
    typedInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void saveTeams(typedInput.value, saveButton, saveStatus);
    });
    actions.append(saveButton, saveStatus.element);
    return [...listedTeamsElements(), typedLabel, typedInput, actions, ...orgElements()];
  }

  function orgRadio(org: string): HTMLElement {
    const row = el('label', 'review-setup-team');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'review-setup-org';
    radio.value = org;
    radio.checked = selectedOrg === org;
    radio.addEventListener('change', () => { if (radio.checked) selectedOrg = org; });
    row.append(radio, el('span', 'review-setup-team-entry', org));
    return row;
  }

  function orgElements(): HTMLElement[] {
    const typedInputId = 'review-setup-typed-org';
    const heading = el('span', 'repo-roots-adder-label', 'ONLY REQUESTS TO ME');
    const hint = el('p', 'first-run-step-hint', 'Reviews pull requests in one organization that request your review directly.');
    const listed = el('div', 'review-setup-teams');
    listed.append(...listing.orgs.map(orgRadio));
    const typedLabel = el('label', 'repo-roots-adder-label', listing.orgs.length > 0 ? 'OR TYPE AN ORGANIZATION' : 'TYPE AN ORGANIZATION');
    typedLabel.htmlFor = typedInputId;
    const typedInput = typedTextInput(typedInputId, 'org-login');
    const actions = el('div', 'first-run-step-actions');
    const saveButton = button({ variant: 'primary', label: 'Save organization' });
    const saveStatus = createActionStatus();
    saveButton.addEventListener('click', () => { void saveOrg(typedInput.value, saveButton, saveStatus); });
    typedInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void saveOrg(typedInput.value, saveButton, saveStatus);
    });
    actions.append(saveButton, saveStatus.element);
    const listedElements = listing.orgs.length > 0 ? [listed] : [];
    return [heading, hint, ...listedElements, typedLabel, typedInput, actions];
  }

  async function saveOrg(typedText: string, saveButton: HTMLButtonElement, saveStatus: ReturnType<typeof createActionStatus>): Promise<void> {
    const org = orgToSave(selectedOrg, typedText);
    if (!org) {
      saveStatus.show('error', 'Pick or type an organization login.');
      return;
    }
    reportReviewSetupAction('save-github-org');
    await saveSettings({ teamReview: { org, team: '' } }, saveButton, saveStatus);
  }

  async function saveTeams(typedText: string, saveButton: HTMLButtonElement, saveStatus: ReturnType<typeof createActionStatus>): Promise<void> {
    const teams = teamsToSave(checkedEntries, typedText);
    if (!teams) {
      saveStatus.show('error', 'Type the team as org/team-slug.');
      return;
    }
    if (teams.length === 0) {
      saveStatus.show('error', 'Pick or type at least one team.');
      return;
    }
    reportReviewSetupAction('save-github-teams');
    await saveSettings({ github: { teams } }, saveButton, saveStatus);
  }

  async function saveSettings(settings: Record<string, unknown>, saveButton: HTMLButtonElement, saveStatus: ReturnType<typeof createActionStatus>): Promise<void> {
    saveButton.disabled = true;
    saveStatus.show('busy', 'Saving');
    try {
      const reply = await sendControlRequest('update-settings', { settings }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
      if (reply.type === 'settings-error') {
        saveStatus.show('error', reply.message);
        return;
      }
      if (reply.type !== 'settings-updated') {
        saveStatus.show('error', 'The server did not confirm the save.');
        return;
      }
      applySettingsBroadcast(reply.settings);
      saveStatus.show('ok', 'Saved. Team review starts on its next poll.');
    } catch (reason) {
      saveStatus.show('error', requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS));
    } finally {
      saveButton.disabled = false;
    }
  }

  let renderedHasReadToken = hasLaneReadToken();

  function render(): void {
    renderedHasReadToken = hasLaneReadToken();
    const steps = decideReviewSetupSteps(listing.viewer, renderedHasReadToken);
    stepsList.replaceChildren(
      buildSetupStep({ title: '1. GitHub', state: steps.github, summary: listing.viewer ? `Signed in as ${listing.viewer}` : '', badge: githubStepBadge, body: githubStepBody }),
      buildSetupStep({ title: '2. Read-only GitHub token', state: steps.readToken, summary: 'Token saved', badge: 'REQUIRED', body: () => laneReadTokenStepBody({ laneWork: 'Team review reads each pull request, its issues and linked pages itself.', onSaved: render }) }),
      buildSetupStep({ title: '3. Who to review for', state: steps.teams, summary: '', badge: 'NEEDED', body: teamsStepBody }),
      buildSetupStep({ title: '4. Review skill (optional)', state: steps.skill, summary: '', badge: '', body: () => [] }),
    );
  }

  async function load(): Promise<void> {
    loadSequence += 1;
    const sequenceAtStart = loadSequence;
    if (checkAgainButton) checkAgainButton.disabled = true;
    loadStatus.show('busy', 'Checking GitHub');
    try {
      const reply = await sendControlRequest('list-github-teams', {}, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
      if (sequenceAtStart !== loadSequence) return;
      if (reply.type !== 'github-teams-listed') {
        loadStatus.show('error', 'The server did not answer with your GitHub teams.');
        return;
      }
      listing = { viewer: reply.viewer, teams: reply.teams, orgs: reply.orgs, error: reply.error };
      loadStatus.clear();
      render();
    } catch (reason) {
      if (sequenceAtStart !== loadSequence) return;
      loadStatus.show('error', requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS));
    } finally {
      if (checkAgainButton && sequenceAtStart === loadSequence) checkAgainButton.disabled = false;
    }
  }

  subscribeSettings((change) => {
    if (change.kind === 'broadcast' && hasLaneReadToken() !== renderedHasReadToken) render();
  });
  render();
  return { element, load };
}
