import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLaneResultFile } from '../lanes/lane-spawn.ts';
import type { LaneSpawn } from '../lanes/lane-spawn.ts';
import { writeUntrustedPayload } from '../lanes/untrusted-payload.ts';
import { DEFAULT_MODELS } from '../../shared/contracts/agent-models.ts';
import { QuestionManagerSettings } from '../../shared/contracts/question-manager.ts';
import type { ManagerVerdict } from '../../shared/contracts/question-manager.ts';
import type { ConversationQuestion } from '../../shared/contracts/session.ts';
import {
  buildManagerRequest, decideByRules, MANAGER_BOOTSTRAP_PROMPT, MANAGER_ITEM_CHARS, MANAGER_PROMPT_FILENAME, MANAGER_RESULT_FILENAME,
  MANAGER_TIMEOUT_MS, MANAGER_UNTRUSTED_SOURCE, mightAnswer, NO_RULE_REASON, parseManagerVerdict, pinByRules, plainLanguageRules, withRulePins,
} from './core/question-manager-core.ts';

const QUESTION_MANAGER_LANE_TOOLS = Object.freeze(['Read', 'Write']);

interface ManagerLaneRequest {
  questions: readonly ConversationQuestion[];
  plainRules: readonly string[];
  task: { title: string | null; repo: string };
  model: string;
  signal: AbortSignal;
}

type QuestionManagerLane = (request: ManagerLaneRequest) => Promise<ManagerVerdict>;

interface DecisionContext {
  taskTitle: string | null;
  signal: AbortSignal;
}

interface QuestionManagerDependencies {
  getSettings: () => unknown;
  getLane?: () => QuestionManagerLane | null;
}

interface SessionQuestionManager {
  readonly isOn: boolean;
  setOn(isOn: boolean): void;
  mightAnswer(): boolean;
  decide(questions: readonly ConversationQuestion[] | null, context: DecisionContext): Promise<ManagerVerdict | null>;
}

function createQuestionManagerLane(spawn: LaneSpawn): QuestionManagerLane {
  return async ({ questions, plainRules, task, model, signal }) => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glimmervoid-question-manager-'));
    try {
      const resultPath = path.join(workDir, MANAGER_RESULT_FILENAME);
      const { prompt, untrustedItems } = buildManagerRequest(questions, plainRules, task, resultPath);
      await writeUntrustedPayload(workDir, { trust: 'untrusted', source: MANAGER_UNTRUSTED_SOURCE, fetchedAt: new Date().toISOString(), items: untrustedItems }, MANAGER_ITEM_CHARS);
      await fs.writeFile(path.join(workDir, MANAGER_PROMPT_FILENAME), prompt, 'utf8');
      await spawn({ id: `question-manager:${randomUUID()}`, name: 'Question manager', cwd: workDir, prompt: MANAGER_BOOTSTRAP_PROMPT, model, signal });
      if (signal.aborted) return { kind: 'escalate', reason: `the manager did not answer within ${MANAGER_TIMEOUT_MS / 1000} s` };
      return parseManagerVerdict(await readLaneResultFile(resultPath), questions, plainRules);
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  };
}

function createQuestionManager({ getSettings, getLane = () => null }: QuestionManagerDependencies) {
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

  function forSession({ projectPath, isOn: isInitiallyOn }: { projectPath: string; isOn: boolean }): SessionQuestionManager {
    let isOn = isInitiallyOn;

    function mightAnswerForSession(): boolean {
      return isOn && mightAnswer(currentSettings());
    }

    async function decide(questions: readonly ConversationQuestion[] | null, { taskTitle, signal }: DecisionContext): Promise<ManagerVerdict | null> {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(MANAGER_TIMEOUT_MS)]);
      const settings = currentSettings();
      if (!settings || !mightAnswerForSession()) return null;
      const ruleVerdict = decideByRules(questions, settings);
      if (ruleVerdict) return ruleVerdict;
      const plainRules = plainLanguageRules(settings);
      const lane = getLane();
      if (!questions || plainRules.length === 0 || !lane) return { kind: 'escalate', reason: NO_RULE_REASON };
      const pins = pinByRules(questions, settings.rules ?? []);
      const request = { questions: pins.unmatched, plainRules, task: { title: taskTitle, repo: projectPath }, model: settings.model ?? DEFAULT_MODELS.questionManager, signal: deadline };
      return lane(request)
        .then((laneVerdict) => withRulePins(laneVerdict, pins))
        .catch((): ManagerVerdict => ({ kind: 'escalate', reason: 'the manager lane failed' }));
    }

    return {
      get isOn() { return isOn; },
      setOn: (nextIsOn) => { isOn = nextIsOn; },
      mightAnswer: mightAnswerForSession,
      decide,
    };
  }

  return { forSession };
}

export { createQuestionManager, createQuestionManagerLane, QUESTION_MANAGER_LANE_TOOLS };
export type { QuestionManagerLane };
