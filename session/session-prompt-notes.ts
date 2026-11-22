import { unrefTimer } from '../shared/timer-deps.ts';
import { hintFor, promptHintsFor, supervisionLine, toolHookFactsOf } from './core/session-routes.ts';
import type { CommandHint, HintedCommand, PromptHint } from './core/session-routes.ts';

interface SessionPromptNotesPort {
  canUseToolHookContext: () => boolean;
  onCommandHint: (command: HintedCommand, outcome: 'shown' | 'followed') => void;
}

interface SessionPromptNotes {
  readonly ranCommands: ReadonlySet<string>;
  armSupervision(canRunHelpCommand: boolean, isEphemeral: boolean, packContextLines: readonly string[]): void;
  holdResumePrompt(resumePrompt: string | null): void;
  takeHeldResumePrompt(explicitPrompt: string | null | undefined): string | null;
  armResumeNote(note: string | null): void;
  armResumeNoteFallback(timeoutMs: number, onFallback: (note: string) => void): void;
  dropResumeNote(): void;
  pendingResumeNote(): string | null;
  takeResumeNote(): string | null;
  noteCommandRan(command: string): void;
  takeCommandHint(event: string, payload: Record<string, unknown>, answers: (command: HintedCommand) => boolean): CommandHint | null;
  queuePromptHint(prompt: unknown): void;
  takePromptNotes(keepsHint: (command: HintedCommand) => boolean): string[];
  forgetHints(): void;
  dispose(): void;
}

function createSessionPromptNotes(port: SessionPromptNotesPort): SessionPromptNotes {
  let pendingSupervisionLine: string | null = null;
  let pendingPackContextLines: readonly string[] = [];
  let pendingResumeNoteValue: string | null = null;
  let resumeNoteAwaitingTurn: string | null = null;
  let heldResumePrompt: string | null = null;
  let fallbackTimer: NodeJS.Timeout | null = null;
  const hintedCommands = new Set<HintedCommand>();
  const shownHintCommands = new Set<HintedCommand>();
  const ranCommands = new Set<string>();
  let queuedCommandHints: PromptHint[] = [];

  function clearFallbackTimer(): void {
    if (!fallbackTimer) return;
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }

  function noteCommandHint(command: HintedCommand, outcome: 'shown' | 'followed'): void {
    if (outcome === 'shown') shownHintCommands.add(command);
    port.onCommandHint(command, outcome);
  }

  function armSupervision(canRunHelpCommand: boolean, isEphemeral: boolean, packContextLines: readonly string[]): void {
    pendingSupervisionLine = canRunHelpCommand ? supervisionLine({ canSpawn: !isEphemeral }) : null;
    pendingPackContextLines = packContextLines;
  }

  function holdResumePrompt(resumePrompt: string | null): void {
    heldResumePrompt = resumePrompt;
  }

  function takeHeldResumePrompt(explicitPrompt: string | null | undefined): string | null {
    const resolved = explicitPrompt !== undefined ? explicitPrompt : heldResumePrompt;
    heldResumePrompt = null;
    return resolved;
  }

  function armResumeNote(note: string | null): void {
    clearFallbackTimer();
    pendingResumeNoteValue = note;
    resumeNoteAwaitingTurn = note;
  }

  function dropResumeNote(): void {
    pendingResumeNoteValue = null;
    resumeNoteAwaitingTurn = null;
    clearFallbackTimer();
  }

  function armResumeNoteFallback(timeoutMs: number, onFallback: (note: string) => void): void {
    clearFallbackTimer();
    if (resumeNoteAwaitingTurn === null) return;
    fallbackTimer = setTimeout(() => {
      fallbackTimer = null;
      const resumeNote = resumeNoteAwaitingTurn;
      if (resumeNote === null) return;
      onFallback(resumeNote);
    }, timeoutMs);
    unrefTimer(fallbackTimer);
  }

  function noteCommandRan(command: string): void {
    const followedHint = ranCommands.has(command) ? undefined : [...shownHintCommands].find((shown) => shown === command);
    ranCommands.add(command);
    if (followedHint !== undefined) noteCommandHint(followedHint, 'followed');
  }

  function takeCommandHint(event: string, payload: Record<string, unknown>, answers: (command: HintedCommand) => boolean): CommandHint | null {
    const facts = toolHookFactsOf(event, payload);
    if (facts === null) return null;
    const hint = hintFor(facts, { answers, hintedCommands, ranCommands });
    if (hint === null) return null;
    hintedCommands.add(hint.command);
    if (!port.canUseToolHookContext()) {
      queuedCommandHints.push(hint);
      return null;
    }
    noteCommandHint(hint.command, 'shown');
    return hint;
  }

  function queuePromptHint(prompt: unknown): void {
    for (const hint of promptHintsFor(prompt, { hintedCommands, ranCommands })) {
      hintedCommands.add(hint.command);
      queuedCommandHints.push(hint);
    }
  }

  function takePromptNotes(keepsHint: (command: HintedCommand) => boolean): string[] {
    const keptHints = queuedCommandHints.filter((hint) => keepsHint(hint.command));
    const notes = [pendingSupervisionLine, ...pendingPackContextLines, ...keptHints.map((hint) => hint.text)].filter((note) => note !== null);
    pendingSupervisionLine = null;
    pendingPackContextLines = [];
    queuedCommandHints = [];
    for (const hint of keptHints) noteCommandHint(hint.command, 'shown');
    return notes;
  }

  function forgetHints(): void {
    hintedCommands.clear();
    shownHintCommands.clear();
    ranCommands.clear();
    queuedCommandHints = [];
  }

  function dispose(): void {
    dropResumeNote();
    pendingSupervisionLine = null;
    pendingPackContextLines = [];
    heldResumePrompt = null;
    queuedCommandHints = [];
  }

  return {
    get ranCommands() { return ranCommands; },
    armSupervision,
    holdResumePrompt,
    takeHeldResumePrompt,
    armResumeNote,
    armResumeNoteFallback,
    dropResumeNote,
    pendingResumeNote: () => resumeNoteAwaitingTurn,
    takeResumeNote: () => {
      const resumeNote = pendingResumeNoteValue;
      pendingResumeNoteValue = null;
      return resumeNote;
    },
    noteCommandRan,
    takeCommandHint,
    queuePromptHint,
    takePromptNotes,
    forgetHints,
    dispose,
  };
}

export { createSessionPromptNotes };
export type { SessionPromptNotes };
