import { decideAgentAvailability, decideAgentPicker } from '../session-card/agent-core.ts';

const PICK_AGENT_DIALOG_TITLE = 'Pick Orchestrator agent';
const PICK_AGENT_DIALOG_MESSAGE = 'Pick an ACP agent Studio can run to start the Orchestrator.';
const PICK_AGENT_CONFIRM_LABEL = 'Start';
export const PICK_AGENT_DIALOG_CHROME = {
  title: PICK_AGENT_DIALOG_TITLE,
  message: PICK_AGENT_DIALOG_MESSAGE,
  confirmLabel: PICK_AGENT_CONFIRM_LABEL,
  closeOnConfirm: false,
} as const;
export const PICK_AGENT_LOADING_TEXT = 'Loading ACP agents.';
export const PICK_AGENT_STARTING_TEXT = 'Starting the Orchestrator.';
export const PICK_AGENT_LIST_LOAD_ERROR = 'The agent list did not load.';
const PICK_AGENT_NONE_AVAILABLE_ERROR = 'No ACP agent is available.';
export const PICK_AGENT_RADIO_GROUP_NAME = 'studio-orchestrator-agent';

interface PickAgentOption {
  id: string;
  label: string;
}

type PickAgentStatusTone = 'busy' | 'error';

interface PickAgentStatus {
  tone: PickAgentStatusTone;
  text: string;
}

export interface PickAgentDialogState {
  options: readonly PickAgentOption[];
  chosenAgentId: string | null;
  isStarting: boolean;
  status: PickAgentStatus | null;
}

export function initialPickAgentDialogState(): PickAgentDialogState {
  return {
    options: [],
    chosenAgentId: null,
    isStarting: false,
    status: { tone: 'busy', text: PICK_AGENT_LOADING_TEXT },
  };
}

export function canStartPickAgent(state: PickAgentDialogState): boolean {
  return !state.isStarting && state.chosenAgentId !== null;
}

export function pickAgentStatusClassName(tone: PickAgentStatusTone): string {
  return tone === 'busy'
    ? 'dialog-hint text-meta text-text-muted'
    : 'dialog-hint text-meta text-state-failed';
}

export function applyPickAgentSelection(state: PickAgentDialogState, agentId: string): PickAgentDialogState {
  if (state.isStarting) return state;
  if (!state.options.some((option) => option.id === agentId)) return state;
  return { ...state, chosenAgentId: agentId };
}

export function applyPickAgentListReply(state: PickAgentDialogState, reply: unknown): PickAgentDialogState {
  const listedReply = typeof reply === 'object' && reply !== null ? (reply as { type?: unknown; error?: unknown; agents?: unknown }) : null;
  if (!listedReply || listedReply.type !== 'agents-listed') {
    return { ...state, options: [], chosenAgentId: null, status: { tone: 'error', text: PICK_AGENT_LIST_LOAD_ERROR } };
  }
  if (typeof listedReply.error === 'string' && listedReply.error.length > 0) {
    return { ...state, options: [], chosenAgentId: null, status: { tone: 'error', text: listedReply.error } };
  }
  const availability = decideAgentAvailability(listedReply);
  const picker = decideAgentPicker(listedReply.agents);
  const options = picker.options;
  if (!availability.canSpawn || options.length === 0) {
    return {
      ...state,
      options,
      chosenAgentId: null,
      status: { tone: 'error', text: availability.guidance || PICK_AGENT_NONE_AVAILABLE_ERROR },
    };
  }
  const chosenAgentId = options.some((option) => option.id === picker.selectedId)
    ? picker.selectedId
    : options[0].id;
  return { ...state, options, chosenAgentId, status: null };
}

export function applyPickAgentListFailure(state: PickAgentDialogState, detail: string): PickAgentDialogState {
  return {
    ...state,
    options: [],
    chosenAgentId: null,
    status: { tone: 'error', text: `Could not load the agent list (${detail}).` },
  };
}

export function beginPickAgentStart(state: PickAgentDialogState): PickAgentDialogState {
  if (!canStartPickAgent(state)) return state;
  return {
    ...state,
    isStarting: true,
    status: { tone: 'busy', text: PICK_AGENT_STARTING_TEXT },
  };
}

export function applyPickAgentStartFailure(state: PickAgentDialogState, message: string): PickAgentDialogState {
  return {
    ...state,
    isStarting: false,
    status: { tone: 'error', text: message },
  };
}
