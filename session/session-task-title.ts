import { open } from 'node:fs/promises';
import type { PersistedTaskTitle } from '../shared/contracts/config.ts';
import type { HookPayload } from '../shared/contracts/index.ts';
import { maskSecrets } from '../shared/secret-patterns.ts';
import type { AgentAdapter } from './adapters/index.ts';
import {
  buildPersistedTaskTitle,
  cleanTaskPrompt,
  extractAiTitle,
  extractHookTaskTitle,
  extractOscTaskTitle,
  extractPromptTaskTitle,
  isSubstantivePrompt,
  resolveRefocusTaskTitle,
  resolveTaskTitle,
  seedTaskTitleSources,
} from './core/task-title-core.ts';
import type { TaskTitleRefinementResult, TaskTitleSources } from './core/task-title-core.ts';

async function readTranscriptTaskTitle(transcriptPath: string, deliveredSecrets: readonly string[]): Promise<string | null> {
  try {
    const transcript = await open(transcriptPath, 'r');
    try {
      const { size } = await transcript.stat();
      const offset = Math.max(0, size - 64 * 1024);
      const readOffset = Math.max(0, offset - 1);
      const buffer = Buffer.alloc(size - readOffset);
      let totalBytesRead = 0;
      while (totalBytesRead < buffer.length) {
        const { bytesRead } = await transcript.read(buffer, totalBytesRead, buffer.length - totalBytesRead, readOffset + totalBytesRead);
        if (bytesRead === 0) break;
        totalBytesRead += bytesRead;
      }
      const tail = buffer.subarray(offset - readOffset, totalBytesRead).toString('utf8');
      const lines = tail.split('\n');
      if (offset > 0 && buffer[0] !== 10) lines.shift();
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        let entry: unknown;
        try {
          entry = JSON.parse(lines[index]);
        } catch {
          continue;
        }
        if (!entry || typeof entry !== 'object') continue;
        if (!('type' in entry) || entry.type !== 'ai-title') continue;
        if (!('aiTitle' in entry) || typeof entry.aiTitle !== 'string') continue;
        const maskedTitle = maskSecrets(entry.aiTitle, deliveredSecrets);
        const normalized = extractAiTitle(JSON.stringify({ type: 'ai-title', aiTitle: maskedTitle }), false);
        if (normalized) return normalized;
      }
      return null;
    } finally {
      await transcript.close();
    }
  } catch {
    return null;
  }
}

interface SessionTaskTitlePort {
  isDestroyed: () => boolean;
  transcriptPath: () => string | null;
  deliveredSecretValues: () => readonly string[];
  emit: (event: string, ...args: unknown[]) => unknown;
}

interface SessionTaskTitleOptions {
  customTitle: string | null;
  persistedTitle: PersistedTaskTitle | undefined;
  resumeSessionId: string | null;
  initialPrompt: string | null;
  titleProfile: AgentAdapter['titleProfile'];
  port: SessionTaskTitlePort;
}

interface SessionTaskTitleController {
  readonly sources: TaskTitleSources;
  readonly customTitle: string | null;
  readonly taskTitle: string | null;
  readonly taskTitleIsCustom: boolean;
  readonly refinedTaskTitle: string | null;
  readonly persistedTaskTitle: PersistedTaskTitle | undefined;
  readonly refocusTaskTitle: string | null;
  readonly recentTaskPrompts: readonly string[];
  readonly promptRevision: number;
  setCustomTitle(title: string | null): void;
  applyRefinement(refinement: TaskTitleRefinementResult): void;
  noteOscTitle(title: string, projectName: string): void;
  noteHookPayload(payload: HookPayload, cwdBasename: string): void;
  notePrompt(prompt: unknown): void;
  refreshFromTranscript(): Promise<void>;
  resetAutomatic(): void;
  refreshSecretMask(): void;
}

function createSessionTaskTitle({
  customTitle: initialCustomTitle,
  persistedTitle,
  resumeSessionId,
  initialPrompt,
  titleProfile,
  port,
}: SessionTaskTitleOptions): SessionTaskTitleController {
  let customTitle = initialCustomTitle || null;
  const maskedSourcesOf = (input: TaskTitleSources): TaskTitleSources => {
    const secrets = port.deliveredSecretValues();
    const masked: TaskTitleSources = {};
    for (const [source, title] of Object.entries(input)) {
      masked[source as keyof TaskTitleSources] = title ? maskSecrets(title, secrets) : title;
    }
    return masked;
  };
  const seededSources = seedTaskTitleSources({
    persistedTitle,
    resumeSessionId,
    customTitle,
    initialPrompt: initialPrompt ? maskSecrets(initialPrompt, port.deliveredSecretValues()) : initialPrompt,
  });
  let stateSignature: string | undefined = JSON.stringify(buildPersistedTaskTitle(seededSources));
  let sources: TaskTitleSources = maskedSourcesOf(seededSources);
  const initialEffective = resolveTaskTitle(sources);
  let taskTitle: string | null = initialEffective.taskTitle;
  let taskTitleIsCustom: boolean = initialEffective.isCustom;
  let readSequence = 0;
  let recentTaskPrompts: string[] = [];
  let promptRevision = 0;

  function updateTaskTitle(): void {
    const secrets = port.deliveredSecretValues();
    sources = maskedSourcesOf(sources);
    recentTaskPrompts = recentTaskPrompts.map((prompt) => maskSecrets(prompt, secrets));
    const effectiveTitle = resolveTaskTitle(sources);
    if (taskTitle !== effectiveTitle.taskTitle || taskTitleIsCustom !== effectiveTitle.isCustom) {
      taskTitle = effectiveTitle.taskTitle;
      taskTitleIsCustom = effectiveTitle.isCustom;
      port.emit('task-title-change', effectiveTitle);
    }
    const titleState = buildPersistedTaskTitle(sources);
    const signature = JSON.stringify(titleState);
    if (signature === stateSignature) return;
    stateSignature = signature;
    port.emit('task-title-state-change', titleState);
  }

  function setCustomTitle(title: string | null): void {
    customTitle = title?.trim() || null;
    sources.customTitle = customTitle;
    updateTaskTitle();
  }

  function applyRefinement(refinement: TaskTitleRefinementResult): void {
    if (refinement.action === 'replace') sources.refinedTitle = refinement.title;
    updateTaskTitle();
  }

  function noteOscTitle(title: string, projectName: string): void {
    const vocabulary = titleProfile.taskTitle;
    if (vocabulary.readsTranscriptTitle) return;
    const oscTitle = extractOscTaskTitle(maskSecrets(title, port.deliveredSecretValues()), projectName, vocabulary);
    if (!oscTitle) return;
    sources.oscTitle = oscTitle;
    updateTaskTitle();
  }

  function noteHookPayload(payload: HookPayload, cwdBasename: string): void {
    const field = titleProfile.taskTitle.hookTitleField;
    const rawTitle = field !== undefined ? payload[field] : undefined;
    const maskedPayload = field !== undefined && typeof rawTitle === 'string'
      ? { ...payload, [field]: maskSecrets(rawTitle, port.deliveredSecretValues()) }
      : payload;
    const hookTitle = extractHookTaskTitle(maskedPayload, cwdBasename, titleProfile.taskTitle);
    if (!hookTitle || hookTitle === sources.aiTitle) return;
    sources.aiTitle = hookTitle;
    updateTaskTitle();
  }

  function notePrompt(prompt: unknown): void {
    const maskedPrompt = typeof prompt === 'string' ? maskSecrets(prompt, port.deliveredSecretValues()) : prompt;
    if (!sources.promptTitle) {
      sources.promptTitle = extractPromptTaskTitle(maskedPrompt);
      updateTaskTitle();
    }
    if (typeof maskedPrompt !== 'string' || !isSubstantivePrompt(maskedPrompt)) return;
    const cleanedPrompt = cleanTaskPrompt(maskedPrompt);
    recentTaskPrompts = [...recentTaskPrompts, cleanedPrompt].slice(-5);
    promptRevision += 1;
    port.emit('task-prompt', { prompt: cleanedPrompt });
  }

  async function refreshFromTranscript(): Promise<void> {
    const transcriptPath = port.transcriptPath();
    if (!titleProfile.taskTitle.readsTranscriptTitle || !transcriptPath) return;
    const sequence = ++readSequence;
    const aiTitle = await readTranscriptTaskTitle(transcriptPath, port.deliveredSecretValues());
    if (port.isDestroyed() || sequence !== readSequence || transcriptPath !== port.transcriptPath() || !aiTitle) return;
    sources.aiTitle = aiTitle;
    updateTaskTitle();
  }

  function resetAutomatic(): void {
    readSequence += 1;
    sources = maskedSourcesOf({ customTitle });
    recentTaskPrompts = [];
    promptRevision += 1;
    port.emit('task-title-reset');
    updateTaskTitle();
  }

  return {
    get sources() { return sources; },
    get customTitle() { return customTitle; },
    get taskTitle() { return taskTitle; },
    get taskTitleIsCustom() { return taskTitleIsCustom; },
    get refinedTaskTitle() { return sources.refinedTitle ?? null; },
    get persistedTaskTitle() { return buildPersistedTaskTitle(sources); },
    get refocusTaskTitle() { return resolveRefocusTaskTitle(sources); },
    get recentTaskPrompts() { return [...recentTaskPrompts]; },
    get promptRevision() { return promptRevision; },
    setCustomTitle,
    applyRefinement,
    noteOscTitle,
    noteHookPayload,
    notePrompt,
    refreshFromTranscript,
    resetAutomatic,
    refreshSecretMask: updateTaskTitle,
  };
}

export { createSessionTaskTitle };
export type { SessionTaskTitleController };
