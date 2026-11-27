import type { OperatorActionOf } from '#shared/contracts/control-messages.ts';
import { createActionStatus } from '../action-status.ts';
import type { ActionStatus } from '../action-status.ts';
import { sendControlMsg } from '../control-ws.ts';
import { el } from '../dom-helpers.ts';
import { textInput } from '../ui/text-input.ts';
import { button } from '../ui/button.ts';
import { buildSetupStep } from '../onboarding/setup-step.ts';
import { createSettingsLink } from '../settings-link.ts';
import updateSettingsAction from '../state/actions/update-settings.ts';
import { onSettingsPayloadChanged, settingsPayloadSnapshot } from '../state/collections/settings.ts';
import { communitySetupStepStates } from './community-setup-core.ts';
import { hasLaneReadToken, laneReadTokenStepBody } from '../github/lane-read-token-step.ts';
import type { CommunitySetupProgress } from './community-setup-core.ts';

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

function savedCommunitySkill(): string {
  const community = settingsPayloadSnapshot().community;
  const block = typeof community === 'object' && community !== null ? community as Record<string, unknown> : {};
  return typeof block.skill === 'string' ? block.skill : '';
}


export function createCommunitySetupCard({ onFinish }: { onFinish: () => void }) {
  const element = el('section', 'first-run-checklist review-setup');
  element.setAttribute('aria-labelledby', 'community-setup-title');
  const heading = el('h2', 'first-run-title', 'Answer community questions');
  heading.id = 'community-setup-title';
  const stepsList = el('ol', 'first-run-steps');
  const foot = el('p', 'first-run-step-hint review-setup-foot', 'Each question gets a researched draft reply. Nothing posts until you post it yourself.');
  foot.append(createSettingsLink('lanes-community', 'community-enabled', 'All community settings'));
  const finishActions = el('div', 'first-run-step-actions');
  const finishButton = button({ variant: 'primary', label: 'Finish setup', action: 'finish-community-setup' });
  finishActions.append(finishButton);
  finishActions.hidden = true;
  element.append(el('span', 'first-run-eyebrow', 'SET UP COMMUNITY'), heading, stepsList, finishActions, foot);

  let progress: CommunitySetupProgress | null = null;

  finishButton.addEventListener('click', () => {
    reportCommunitySetupAction('finish-community-setup');
    progress = null;
    onFinish();
  });

  function firstUnmetStep(): CommunitySetupProgress | null {
    if (!hasLaneReadToken()) return 'readToken';
    return null;
  }

  function moveTo(nextProgress: CommunitySetupProgress): void {
    progress = nextProgress === 'readToken' && hasLaneReadToken() ? 'skill' : nextProgress;
    render();
    (stepsList.querySelector<HTMLElement>('[aria-current="step"] input') ?? (finishActions.hidden ? null : finishButton))?.focus();
  }

  async function saveSettingsPatch(settings: Record<string, unknown>, saveButton: HTMLButtonElement, status: ActionStatus, nextProgress: CommunitySetupProgress): Promise<void> {
    saveButton.disabled = true;
    status.show('busy', 'Saving');
    try {
      const outcome = await updateSettingsAction({ settings });
      if (!outcome.ok) {
        status.show('error', outcome.error.message);
        return;
      }
      if (outcome.reply.type !== 'settings-updated') {
        status.show('error', 'The server did not confirm the save.');
        return;
      }
      moveTo(nextProgress);
    } finally {
      saveButton.disabled = false;
    }
  }

  function fieldStepBody(field: FieldStep): HTMLElement[] {
    const input = textInput({ id: field.inputId, value: field.initialValue, placeholder: field.placeholder, type: field.inputType });
    const label = el('label', 'repo-roots-adder-label', field.label);
    label.htmlFor = input.id;
    const actions = el('div', 'first-run-step-actions');
    const status = createActionStatus();
    const saveButton = button({ variant: 'primary', label: field.saveLabel, action: field.action });
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
      const skipButton = button({ variant: 'secondary', label: 'Skip', action: 'skip-community-setup-step', onClick: () => moveTo(field.nextProgress) });
      actions.append(skipButton);
    }
    actions.append(status.element);
    return [el('p', 'first-run-step-text', field.advice), label, input, actions];
  }

  const skillStepBody = () => fieldStepBody({
    advice: 'The Claude Code skill the research agent follows for each question, typed by name. A skill that knows your docs and support playbook gives the best drafts. Skip to research with whatever skills the agent has.',
    label: 'SKILL', inputId: 'community-setup-skill', inputType: 'text', initialValue: savedCommunitySkill(), placeholder: 'skill name',
    saveLabel: 'Save skill', action: 'save-community-skill', nextProgress: 'finished', isSkippable: true,
    settingsPatch: (typedText) => ({ community: { skill: typedText.trim().replace(/^\//, '') } }),
  });

  function render(): void {
    if (!progress) return;
    const states = communitySetupStepStates(progress);
    stepsList.replaceChildren(
      buildSetupStep({ title: '1. Read-only GitHub token', state: states.readToken, summary: 'Token saved', badge: 'REQUIRED', body: () => laneReadTokenStepBody({ laneWork: 'Community research reads the GitHub issues, code and pages a question links.', onSaved: () => moveTo('skill') }) }),
      buildSetupStep({ title: '2. Research skill (optional)', state: states.skill, summary: savedCommunitySkill() || 'No skill', badge: '', body: skillStepBody }),
    );
    finishActions.hidden = progress !== 'finished';
  }

  function open(): void {
    progress = firstUnmetStep() ?? 'skill';
    render();
  }

  onSettingsPayloadChanged(() => {
    if (progress === 'readToken' && hasLaneReadToken()) moveTo('skill');
  });

  return { element, open, isOpen: () => progress !== null, needsSetup: () => firstUnmetStep() !== null };
}
