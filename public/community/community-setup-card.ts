import type { OperatorActionOf } from '#shared/contracts/control-messages.ts';
import { createActionStatus, DEFAULT_REPLY_TIMEOUT_MS, requestFailureText } from '../action-status.ts';
import type { ActionStatus } from '../action-status.ts';
import { sendControlMsg, sendControlRequest } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { buildSetupStep } from '../onboarding/setup-step.ts';
import { createSettingsLink } from '../settings/settings-link.ts';
import { applySettingsBroadcast, settingsPayloadSnapshot } from '../settings/settings-store.ts';
import { communitySetupStepStates, discordChannelsFromText } from './community-setup-core.ts';
import type { CommunitySetupProgress } from './community-setup-core.ts';

const DEFAULT_COMMUNITY_PROJECT_ID = 2;

interface FieldStep {
  advice: string;
  label: string;
  inputId: string;
  inputType: 'text' | 'password' | 'number';
  initialValue: string;
  placeholder: string;
  saveLabel: string;
  action: OperatorActionOf<'onboarding'>;
  nextProgress: CommunitySetupProgress;
  isSkippable: boolean;
  settingsPatch: (typedText: string) => Record<string, unknown> | string;
}

function reportCommunitySetupAction(action: OperatorActionOf<'onboarding'>): void {
  sendControlMsg({ type: 'dashboard-telemetry', event: 'operator_action', properties: { surface: 'onboarding', action } });
}

function savedCommunitySettings(): { projectId: number; skill: string; discordChannels: string[] } {
  const community = settingsPayloadSnapshot().community;
  const block = typeof community === 'object' && community !== null ? community as Record<string, unknown> : {};
  const channels = Array.isArray(block.discordChannels) ? block.discordChannels.filter((channel) => typeof channel === 'string') : [];
  return {
    projectId: typeof block.projectId === 'number' ? block.projectId : DEFAULT_COMMUNITY_PROJECT_ID,
    skill: typeof block.skill === 'string' ? block.skill : '',
    discordChannels: channels,
  };
}

function textInput(id: string, value: string, placeholder: string, type: string): HTMLInputElement {
  const input = el('input', 'dialog-input repo-roots-adder-input');
  input.id = id;
  input.type = type;
  input.value = value;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.spellcheck = false;
  return input;
}

function actionButton(label: string, kind: 'confirm' | 'cancel'): HTMLButtonElement {
  const button = el('button', `btn-dialog btn-dialog-${kind}`, label);
  button.type = 'button';
  return button;
}

export function createCommunitySetupCard({ onFinish }: { onFinish: () => void }) {
  const element = el('section', 'first-run-checklist review-setup');
  element.setAttribute('aria-labelledby', 'community-setup-title');
  const heading = el('h2', 'first-run-title', 'Answer community questions');
  heading.id = 'community-setup-title';
  const stepsList = el('ol', 'first-run-steps');
  const foot = el('p', 'first-run-step-hint review-setup-foot', 'Each question gets a researched draft reply. Nothing posts until you post it yourself. ');
  foot.append(createSettingsLink('lanes-community', 'community-enabled', 'All community settings'));
  const finishActions = el('div', 'first-run-step-actions');
  const finishButton = actionButton('Finish setup', 'confirm');
  finishActions.append(finishButton);
  finishActions.hidden = true;
  element.append(el('span', 'first-run-eyebrow', 'SET UP COMMUNITY'), heading, stepsList, finishActions, foot);

  let progress: CommunitySetupProgress | null = null;

  finishButton.addEventListener('click', () => {
    reportCommunitySetupAction('finish-community-setup');
    progress = null;
    onFinish();
  });

  function moveTo(nextProgress: CommunitySetupProgress): void {
    progress = nextProgress;
    render();
    (stepsList.querySelector<HTMLElement>('[aria-current="step"] input') ?? (finishActions.hidden ? null : finishButton))?.focus();
  }

  async function saveSettingsPatch(settings: Record<string, unknown>, button: HTMLButtonElement, status: ActionStatus, nextProgress: CommunitySetupProgress): Promise<void> {
    button.disabled = true;
    status.show('busy', 'Saving');
    try {
      const reply = await sendControlRequest('update-settings', { settings }, { timeoutMs: DEFAULT_REPLY_TIMEOUT_MS });
      if (reply.type === 'settings-error') {
        status.show('error', reply.message);
        return;
      }
      if (reply.type !== 'settings-updated') {
        status.show('error', 'The server did not confirm the save.');
        return;
      }
      applySettingsBroadcast(reply.settings);
      moveTo(nextProgress);
    } catch (reason) {
      status.show('error', requestFailureText(reason, DEFAULT_REPLY_TIMEOUT_MS));
    } finally {
      button.disabled = false;
    }
  }

  function fieldStepBody(field: FieldStep): HTMLElement[] {
    const input = textInput(field.inputId, field.initialValue, field.placeholder, field.inputType);
    const label = el('label', 'repo-roots-adder-label', field.label);
    label.htmlFor = input.id;
    const actions = el('div', 'first-run-step-actions');
    const status = createActionStatus();
    const saveButton = actionButton(field.saveLabel, 'confirm');
    const submit = () => {
      const patch = field.settingsPatch(input.value);
      if (typeof patch === 'string') {
        status.show('error', patch);
        return;
      }
      reportCommunitySetupAction(field.action);
      void saveSettingsPatch(patch, saveButton, status, field.nextProgress);
    };
    saveButton.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      submit();
    });
    actions.append(saveButton);
    if (field.isSkippable) {
      const skipButton = actionButton('Skip', 'cancel');
      skipButton.addEventListener('click', () => moveTo(field.nextProgress));
      actions.append(skipButton);
    }
    actions.append(status.element);
    return [el('p', 'first-run-step-text', field.advice), label, input, actions];
  }

  const keyStepBody = () => fieldStepBody({
    advice: 'Glimmervoid reads new forum and Discord questions through your PostHog personal API key. Create one in PostHog under Settings, Personal API keys, with read access to the project that holds the questions.',
    label: 'PERSONAL API KEY', inputId: 'community-setup-key', inputType: 'password', initialValue: '', placeholder: 'phx_',
    saveLabel: 'Save key', action: 'save-community-key', nextProgress: 'project', isSkippable: false,
    settingsPatch: (typedText) => (typedText.trim() ? { posthog: { apiKey: typedText.trim() } } : 'Paste a PostHog personal API key.'),
  });

  const projectStepBody = () => fieldStepBody({
    advice: "The PostHog project that holds the synced community forum table and the Discord bot events. PostHog's own community lives in project 2.",
    label: 'PROJECT ID', inputId: 'community-setup-project', inputType: 'number', initialValue: String(savedCommunitySettings().projectId), placeholder: String(DEFAULT_COMMUNITY_PROJECT_ID),
    saveLabel: 'Use project', action: 'save-community-project', nextProgress: 'skill', isSkippable: false,
    settingsPatch: (typedText) => {
      const projectId = Number(typedText.trim());
      return Number.isInteger(projectId) && projectId > 0 ? { community: { projectId } } : 'Type the project id as a whole number, such as 2.';
    },
  });

  const skillStepBody = () => fieldStepBody({
    advice: 'The Claude Code skill the research agent follows for each question, typed by name. A skill that knows your docs and support playbook gives the best drafts. Skip to research with whatever skills the agent has.',
    label: 'SKILL', inputId: 'community-setup-skill', inputType: 'text', initialValue: savedCommunitySettings().skill, placeholder: 'skill name',
    saveLabel: 'Save skill', action: 'save-community-skill', nextProgress: 'discord', isSkippable: true,
    settingsPatch: (typedText) => ({ community: { skill: typedText.trim() } }),
  });

  const discordStepBody = () => fieldStepBody({
    advice: 'Discord questions come from a Discord bot that sends message_sent and thread_created events into the project above. With that bot in place, list the channels to watch by name, without the #. A cheap model picks out the real questions; only those are researched.',
    label: 'CHANNELS', inputId: 'community-setup-discord', inputType: 'text', initialValue: savedCommunitySettings().discordChannels.join(', '), placeholder: 'community-questions, help',
    saveLabel: 'Save channels', action: 'save-community-discord', nextProgress: 'finished', isSkippable: true,
    settingsPatch: (typedText) => {
      const discordChannels = discordChannelsFromText(typedText);
      return discordChannels.length > 0 ? { community: { discordChannels } } : 'Type at least one channel, or skip.';
    },
  });

  function render(): void {
    if (!progress) return;
    const states = communitySetupStepStates(progress);
    stepsList.replaceChildren(
      buildSetupStep({ title: '1. PostHog personal API key', state: states.key, summary: 'Key saved', badge: 'NEEDED', body: keyStepBody }),
      buildSetupStep({ title: '2. PostHog project', state: states.project, summary: `Project ${savedCommunitySettings().projectId}`, badge: '', body: projectStepBody }),
      buildSetupStep({ title: '3. Research skill (optional)', state: states.skill, summary: savedCommunitySettings().skill || 'No skill', badge: '', body: skillStepBody }),
      buildSetupStep({ title: '4. Discord (optional)', state: states.discord, summary: savedCommunitySettings().discordChannels.map((channel) => `#${channel}`).join(' ') || 'Forum only', badge: '', body: discordStepBody }),
    );
    finishActions.hidden = progress !== 'finished';
  }

  function open(): void {
    progress = 'key';
    render();
  }

  return { element, open, isOpen: () => progress !== null };
}
