import { isImeProcessingKeydown } from '../session-card/ime-core.ts';

export const MAX_INPUT_HEIGHT_PX = 240;
export const ATTACH_ICON_PATH = 'M10.5 4.5L5.8 9.2a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.2-4.2';
export const SEND_ICON_PATH = 'M8 13V3M3.5 7.5L8 3l4.5 4.5';
export const STOP_ICON_PATH = 'M5 5h6v6H5z';
export const REMOVE_ICON_PATH = 'M4.5 4.5l7 7M11.5 4.5l-7 7';

interface ComposerState {
  readonly hasText: boolean;
  readonly attachedFileNames: readonly string[];
  readonly isDropReady: boolean;
}

export const INITIAL_COMPOSER_STATE: ComposerState = {
  hasText: false,
  attachedFileNames: [],
  isDropReady: false,
};

interface ComposerSlotState {
  readonly hasDraft: boolean;
  readonly isSendDisabled: boolean;
  readonly isStopDisabled: boolean;
  readonly dataHasDraft: 'true' | 'false';
  readonly dataTurnRunning: 'true' | 'false';
}

interface ComposerKeydownInput {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
  readonly keyCode?: number;
}

type ComposerKeydownDecision = 'escape' | 'submit' | 'none';

type ComposerSubmitResult =
  | { readonly shouldSubmit: false; readonly state: ComposerState }
  | { readonly shouldSubmit: true; readonly text: string; readonly attachments: string[]; readonly state: ComposerState };

function composerHasDraft(state: ComposerState): boolean {
  return state.hasText || state.attachedFileNames.length > 0;
}

export function composerSlotStateOf(state: ComposerState, isTurnRunning: boolean): ComposerSlotState {
  const hasDraft = composerHasDraft(state);
  return {
    hasDraft,
    isSendDisabled: !hasDraft,
    isStopDisabled: !isTurnRunning,
    dataHasDraft: hasDraft ? 'true' : 'false',
    dataTurnRunning: isTurnRunning ? 'true' : 'false',
  };
}

export function applyComposerDraftText(state: ComposerState, rawText: string): ComposerState {
  const hasText = rawText.trim().length > 0;
  if (state.hasText === hasText) return state;
  return { ...state, hasText };
}

export function addComposerAttachment(state: ComposerState, fileName: string): ComposerState {
  if (state.attachedFileNames.includes(fileName)) return state;
  return { ...state, attachedFileNames: [...state.attachedFileNames, fileName] };
}

export function removeComposerAttachment(state: ComposerState, fileName: string): ComposerState {
  if (!state.attachedFileNames.includes(fileName)) return state;
  return {
    ...state,
    attachedFileNames: state.attachedFileNames.filter((attachedFileName) => attachedFileName !== fileName),
  };
}

export function setComposerDropReady(state: ComposerState, isDropReady: boolean): ComposerState {
  if (state.isDropReady === isDropReady) return state;
  return { ...state, isDropReady };
}

export function decideComposerSubmit(state: ComposerState, rawText: string): ComposerSubmitResult {
  const text = rawText.trim();
  if (text.length === 0 && state.attachedFileNames.length === 0) {
    return { shouldSubmit: false, state };
  }
  return {
    shouldSubmit: true,
    text,
    attachments: [...state.attachedFileNames],
    state: {
      ...state,
      hasText: false,
      attachedFileNames: [],
    },
  };
}

export function decideComposerKeydown(input: ComposerKeydownInput): ComposerKeydownDecision {
  if (input.key === 'Escape') return 'escape';
  if (input.key !== 'Enter' || input.shiftKey) return 'none';
  if (input.isComposing || isImeProcessingKeydown(input)) return 'none';
  return 'submit';
}

export function shouldAttachPastedFiles(fileCount: number, plainText: string): boolean {
  return fileCount > 0 && plainText === '';
}

export function carriesFileTransferTypes(types: readonly string[]): boolean {
  return types.includes('Files');
}

export function computeFittedInputHeightPx(value: string, isConnected: boolean, scrollHeight: number): number | null {
  if (value === '' || !isConnected) return null;
  return Math.min(scrollHeight, MAX_INPUT_HEIGHT_PX);
}
