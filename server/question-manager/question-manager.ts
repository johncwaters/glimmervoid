import os from 'node:os';
import { runGit } from '../git/git-exec.ts';
import { githubRepoSlugFromRemote } from '../github/core/team-review-core.ts';
import { QuestionManagerSettings } from '../../shared/contracts/question-manager.ts';
import type { ManagerVerdict } from '../../shared/contracts/question-manager.ts';
import type { ConversationQuestion } from '../../shared/contracts/session.ts';
import { decideByRules, isManagerOn, mightAnswer, needsRepoSlug } from './core/question-manager-core.ts';

const ORIGIN_URL_TIMEOUT_MS = 5_000;

interface QuestionManagerDependencies {
  getSettings: () => unknown;
  readOriginUrl?: (projectPath: string) => Promise<string | null>;
  homeDir?: string;
}

type RepoSlugLookup = { isKnown: true; slug: string | null } | { isKnown: false };

interface SessionQuestionManager {
  mightAnswer(): boolean;
  decide(questions: readonly ConversationQuestion[] | null): Promise<ManagerVerdict | null>;
}

function didGitExit(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number';
}

async function readOriginUrlWithGit(projectPath: string): Promise<string | null> {
  const remote = await runGit(['remote', 'get-url', 'origin'], { cwd: projectPath, timeoutMs: ORIGIN_URL_TIMEOUT_MS });
  if (remote.ok) return remote.out || null;
  if (remote.timedOut || !didGitExit(remote.error)) throw new Error(`git remote get-url origin failed: ${remote.err}`);
  return null;
}

function createQuestionManager({ getSettings, readOriginUrl = readOriginUrlWithGit, homeDir = os.homedir() }: QuestionManagerDependencies) {
  let lastRawSettings: unknown;
  let lastParsedSettings: QuestionManagerSettings | null = null;

  function currentSettings(): QuestionManagerSettings | null {
    const rawSettings = getSettings();
    if (rawSettings === lastRawSettings) return lastParsedSettings;
    lastRawSettings = rawSettings;
    const parsed = QuestionManagerSettings.safeParse(rawSettings);
    lastParsedSettings = parsed.success ? parsed.data : null;
    return lastParsedSettings;
  }

  function forSession({ projectPath }: { projectPath: string }): SessionQuestionManager {
    let repoSlug: Promise<RepoSlugLookup> | null = null;

    function resolveRepoSlug(): Promise<RepoSlugLookup> {
      repoSlug ??= readOriginUrl(projectPath)
        .then((remoteUrl): RepoSlugLookup => ({ isKnown: true, slug: remoteUrl ? githubRepoSlugFromRemote(remoteUrl) : null }))
        .catch((): RepoSlugLookup => {
          repoSlug = null;
          return { isKnown: false };
        });
      return repoSlug;
    }

    async function decide(questions: readonly ConversationQuestion[] | null): Promise<ManagerVerdict | null> {
      const settings = currentSettings();
      if (!settings || !mightAnswer(settings)) return null;
      const slugLookup: RepoSlugLookup = needsRepoSlug(settings) ? await resolveRepoSlug() : { isKnown: true, slug: null };
      if (!slugLookup.isKnown) return null;
      if (!isManagerOn(settings, { path: projectPath, slug: slugLookup.slug }, homeDir)) return null;
      return decideByRules(questions, settings);
    }

    return {
      mightAnswer: () => mightAnswer(currentSettings()),
      decide,
    };
  }

  return { forSession };
}

export { createQuestionManager };
