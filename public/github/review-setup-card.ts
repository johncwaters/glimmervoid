import type { GithubTeam, OperatorActionOf } from '#shared/contracts/control-messages.ts';
import { createActionStatus, DEFAULT_REPLY_TIMEOUT_MS, requestFailureText } from '../action-status.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { buildCommandRow, buildSetupStep } from '../onboarding/setup-step.ts';
import { createSettingsLink } from '../settings/settings-link.ts';
import { applySettingsBroadcast } from '../settings/settings-store.ts';
import { TEAM_REVIEW_SETTINGS_SECTION_ID, TEAM_REVIEW_SETTINGS_SETTING_ID } from './team-review-view-core.ts';
import { decideReviewSetupSteps, teamOptionsOf, teamsToSave } from './review-setup-core.ts';

const GH_SIGN_IN_COMMAND = 'gh auth login';

interface GithubTeamsListing { viewer: string | null; teams: GithubTeam[]; error: string | null }

function reportReviewSetupAction(action: OperatorActionOf<'onboarding'>): void {
  sendControlMsg({ type: 'dashboard-telemetry', event: 'operator_action', properties: { surface: 'onboarding', action } });
}

export function createReviewSetupCard() {
  const element = el('section', 'first-run-checklist review-setup');
  element.setAttribute('aria-labelledby', 'review-setup-title');
  const heading = el('h2', 'first-run-title', 'Connect GitHub to see pull requests');
  heading.id = 'review-setup-title';
  const stepsList = el('ol', 'first-run-steps');
  const loadStatus = createActionStatus();
  const foot = el('p', 'first-run-step-hint review-setup-foot', 'Team review drafts a review of each teammate pull request. Nothing posts until you choose Approve or Comment. ');
  foot.append(createSettingsLink(TEAM_REVIEW_SETTINGS_SECTION_ID, TEAM_REVIEW_SETTINGS_SETTING_ID, 'All team review settings'));
  element.append(el('span', 'first-run-eyebrow', 'SET UP REVIEWS'), heading, stepsList, loadStatus.element, foot);

  let listing: GithubTeamsListing = { viewer: null, teams: [], error: null };
  let loadSequence = 0;
  let checkAgainButton: HTMLButtonElement | null = null;
  const checkedEntries = new Set<string>();

  function githubStepBody(): HTMLElement[] {
    const actions = el('div', 'first-run-step-actions');
    checkAgainButton = el('button', 'btn-dialog btn-dialog-cancel', 'Check again');
    checkAgainButton.type = 'button';
    checkAgainButton.addEventListener('click', () => {
      reportReviewSetupAction('check-github-again');
      void load();
    });
    actions.append(checkAgainButton);
    return [
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
    if (listing.teams.length === 0) return [el('p', 'first-run-step-hint', 'GitHub lists no teams for you. Type one below.')];
    const list = el('div', 'review-setup-teams');
    list.append(...teamOptionsOf(listing.teams).map((option) => teamCheckbox(option.entry, option.label)));
    return [el('span', 'repo-roots-adder-label', 'YOUR GITHUB TEAMS'), list];
  }

  function teamsStepBody(): HTMLElement[] {
    const typedInputId = 'review-setup-typed-team';
    const typedLabel = el('label', 'repo-roots-adder-label', listing.teams.length > 0 ? 'OR TYPE A TEAM' : 'TYPE A TEAM');
    typedLabel.htmlFor = typedInputId;
    const typedInput = el('input', 'dialog-input repo-roots-adder-input');
    typedInput.id = typedInputId;
    typedInput.type = 'text';
    typedInput.placeholder = 'org/team-slug';
    typedInput.autocomplete = 'off';
    typedInput.spellcheck = false;
    const actions = el('div', 'first-run-step-actions');
    const saveButton = el('button', 'btn-dialog btn-dialog-confirm', 'Save teams');
    saveButton.type = 'button';
    const saveStatus = createActionStatus();
    saveButton.addEventListener('click', () => { void saveTeams(typedInput.value, saveButton, saveStatus); });
    typedInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      void saveTeams(typedInput.value, saveButton, saveStatus);
    });
    actions.append(saveButton, saveStatus.element);
    return [...listedTeamsElements(), typedLabel, typedInput, actions];
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
    saveButton.disabled = true;
    saveStatus.show('busy', 'Saving');
    try {
      const reply = await sendControlRequest('update-settings', { settings: { github: { teams } } }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
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

  function render(): void {
    const steps = decideReviewSetupSteps(listing.viewer);
    stepsList.replaceChildren(
      buildSetupStep({ title: '1. GitHub CLI', state: steps.github, summary: listing.viewer ? `Signed in as ${listing.viewer}` : '', badge: 'NOT SIGNED IN', body: githubStepBody }),
      buildSetupStep({ title: '2. Your GitHub teams', state: steps.teams, summary: '', badge: 'NEEDED', body: teamsStepBody }),
      buildSetupStep({ title: '3. Review skill', state: steps.skill, summary: '', badge: '', body: () => [] }),
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
      listing = { viewer: reply.viewer, teams: reply.teams, error: reply.error };
      loadStatus.clear();
      render();
    } catch (reason) {
      if (sequenceAtStart !== loadSequence) return;
      loadStatus.show('error', requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS));
    } finally {
      if (checkAgainButton && sequenceAtStart === loadSequence) checkAgainButton.disabled = false;
    }
  }

  render();
  return { element, load };
}
