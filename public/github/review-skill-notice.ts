import { createActionStatus, DEFAULT_REPLY_TIMEOUT_MS, requestFailureText } from '../action-status.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { isSkillChoicePending, readTeamReviewEnvironment, teamReviewSuggestions } from '../settings/team-review-settings-core.ts';
import { applySettingsBroadcast, requestTeamReviewEnvironmentOnce, settingsPayloadSnapshot } from '../settings/settings-store.ts';
import { teamReviewStatusView } from './team-review-store.ts';

const NO_SKILL_OPTION = { value: '', label: 'No skill' };

export function createReviewSkillNotice() {
  const element = el('div', 'review-skill-notice');
  element.hidden = true;
  const selectId = 'review-skill-notice-select';
  const label = el('label', 'review-skill-notice-label', 'Pick a review skill');
  label.htmlFor = selectId;
  const select = el('select', 'dialog-input review-skill-notice-select');
  select.id = selectId;
  const saveButton = el('button', 'btn-dialog btn-dialog-confirm', 'Save skill');
  saveButton.type = 'button';
  const saveStatus = createActionStatus();
  element.append(label, select, saveButton, saveStatus.element);
  let renderedOptionsSignature = '';

  function syncOptions(): void {
    const environment = readTeamReviewEnvironment(settingsPayloadSnapshot().teamReviewEnvironment);
    if (!environment || environment.agents.length === 0) requestTeamReviewEnvironmentOnce();
    const options = [...teamReviewSuggestions('review-skills', environment, {}), NO_SKILL_OPTION];
    const signature = JSON.stringify(options);
    if (signature === renderedOptionsSignature) return;
    renderedOptionsSignature = signature;
    const selectedValue = select.value;
    select.replaceChildren(...options.map((option) => {
      const optionElement = el('option', '', option.value || option.label);
      optionElement.value = option.value;
      if (option.value) optionElement.title = option.label;
      return optionElement;
    }));
    if (options.some((option) => option.value === selectedValue)) select.value = selectedValue;
  }

  function sync(): void {
    const isSkillNeeded = teamReviewStatusView()?.configured === true && isSkillChoicePending(settingsPayloadSnapshot().teamReview);
    element.hidden = !isSkillNeeded;
    if (isSkillNeeded) syncOptions();
  }

  async function saveSkill(): Promise<void> {
    sendControlMsg({ type: 'dashboard-telemetry', event: 'operator_action', properties: { surface: 'onboarding', action: 'save-review-skill' } });
    saveButton.disabled = true;
    saveStatus.show('busy', 'Saving');
    try {
      const reply = await sendControlRequest('update-settings', { settings: { teamReview: { skill: select.value } } }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
      if (reply.type === 'settings-error') {
        saveStatus.show('error', reply.message);
        return;
      }
      if (reply.type !== 'settings-updated') {
        saveStatus.show('error', 'The server did not confirm the save.');
        return;
      }
      saveStatus.clear();
      applySettingsBroadcast(reply.settings);
    } catch (reason) {
      saveStatus.show('error', requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS));
    } finally {
      saveButton.disabled = false;
    }
  }

  saveButton.addEventListener('click', () => { void saveSkill(); });
  return { element, sync };
}
