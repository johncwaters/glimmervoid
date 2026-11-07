import type { ConversationAnswers, ConversationQuestion } from '../../../shared/contracts/session.ts';
import { ManagerLaneResult } from '../../../shared/contracts/question-manager.ts';
import type { ManagerAnswer, ManagerVerdict, QuestionManagerSettings, QuestionMatchRule, QuestionRule } from '../../../shared/contracts/question-manager.ts';
import { UNTRUSTED_PAYLOAD_FILENAME, UNTRUSTED_PREAMBLE } from '../../../shared/contracts/untrusted-payload.ts';
import type { UntrustedItem } from '../../../shared/contracts/untrusted-payload.ts';

const MULTI_SELECT_SEPARATOR = ', ';
const MANAGER_PROMPT_FILENAME = 'manager-prompt.txt';
const MANAGER_RESULT_FILENAME = 'manager-result.json';
const MANAGER_BOOTSTRAP_PROMPT = `Read ${MANAGER_PROMPT_FILENAME} and follow its instructions`;
const MANAGER_TIMEOUT_MS = 60_000;
const MANAGER_UNTRUSTED_SOURCE = 'question-manager';
const MANAGER_ITEM_CHARS = 8000;
const MANAGER_REASON_CHARS = 200;
const MANAGER_RULE_NAME_CHARS = 80;
const NO_RULE_REASON = 'no rule covers this question';
const HIGH_RISK_STEMS = [
  'push', 'forc', 'delet', 'remov', 'drop', 'deploy', 'publish', 'releas', 'merg', 'secret', 'token', 'password',
  'credential', 'reset', 'revert', 'rebas', 'destro', 'wip', 'purg', 'truncat', 'overwrit', 'production', 'rm',
];
const HIGH_RISK_PATTERN = new RegExp(`\\b(?:${HIGH_RISK_STEMS.join('|')})\\w*`, 'i');

export function mightAnswer(settings: QuestionManagerSettings | null | undefined): boolean {
  return (settings?.rules ?? []).length > 0;
}

function splitIdentifiers(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
}

function riskWordIn(questions: readonly ConversationQuestion[]): string | null {
  for (const question of questions) {
    const texts = [question.question, question.header, ...question.options.flatMap((option) => [option.label, option.description])];
    for (const text of texts) {
      const match = HIGH_RISK_PATTERN.exec(splitIdentifiers(text));
      if (match) return match[0];
    }
  }
  return null;
}

function isMatchRule(rule: QuestionRule): rule is QuestionMatchRule {
  return typeof rule !== 'string';
}

export function plainLanguageRules(settings: QuestionManagerSettings): string[] {
  return (settings.rules ?? []).filter((rule): rule is string => typeof rule === 'string');
}

function exactLabels(question: ConversationQuestion, picks: readonly string[]): string[] | null {
  if (!question.multiSelect && picks.length > 1) return null;
  const labels = picks.map((pick) => question.options.find((option) => option.label.toLowerCase() === pick.toLowerCase())?.label);
  if (labels.some((label) => label === undefined)) return null;
  return labels.filter((label): label is string => label !== undefined);
}

function pickedLabels(question: ConversationQuestion, rule: QuestionMatchRule): string[] | null {
  if (!question.question.toLowerCase().includes(rule.question.toLowerCase())) return null;
  return exactLabels(question, rule.pick);
}

interface RulePins {
  answers: ConversationAnswers;
  ruleNames: string[];
  unmatched: ConversationQuestion[];
}

export function pinByRules(questions: readonly ConversationQuestion[], rules: readonly QuestionRule[]): RulePins {
  const pins: RulePins = { answers: {}, ruleNames: [], unmatched: [] };
  const objectRules = rules.filter(isMatchRule);
  for (const question of questions) {
    const matched = objectRules
      .map((rule) => ({ rule, labels: pickedLabels(question, rule) }))
      .find((candidate) => candidate.labels !== null);
    if (!matched?.labels) {
      pins.unmatched.push(question);
      continue;
    }
    pins.answers[question.question] = matched.labels.join(MULTI_SELECT_SEPARATOR);
    if (!pins.ruleNames.includes(matched.rule.name)) pins.ruleNames.push(matched.rule.name);
  }
  return pins;
}

function matchRules(questions: readonly ConversationQuestion[], rules: readonly QuestionRule[]): ManagerVerdict | null {
  const pins = pinByRules(questions, rules);
  if (pins.unmatched.length > 0) return null;
  return { kind: 'answer', answers: pins.answers, ruleName: pins.ruleNames.join(MULTI_SELECT_SEPARATOR), by: 'rule' };
}

export function withRulePins(laneVerdict: ManagerVerdict, pins: RulePins): ManagerVerdict {
  if (laneVerdict.kind !== 'answer' || pins.ruleNames.length === 0) return laneVerdict;
  const ruleName = [...pins.ruleNames, laneVerdict.ruleName].join(MULTI_SELECT_SEPARATOR).slice(0, MANAGER_RULE_NAME_CHARS);
  return { ...laneVerdict, answers: { ...laneVerdict.answers, ...pins.answers }, ruleName };
}

export function decideByRules(questions: readonly ConversationQuestion[] | null, settings: QuestionManagerSettings): ManagerVerdict | null {
  if (!questions || questions.length === 0) return { kind: 'escalate', reason: 'the question could not be read' };
  const riskWord = riskWordIn(questions);
  if (riskWord) return { kind: 'escalate', reason: `risk word "${riskWord}"` };
  return matchRules(questions, settings.rules ?? []);
}

function questionRef(index: number): string {
  return `question-${index + 1}`;
}

export function buildManagerRequest(
  questions: readonly ConversationQuestion[],
  plainRules: readonly string[],
  task: { title: string | null; repo: string },
  resultPath: string,
): { prompt: string; untrustedItems: UntrustedItem[] } {
  const prompt = [
    `A coding agent working in ${task.repo} asked its operator the questions in ${UNTRUSTED_PAYLOAD_FILENAME}.`,
    'Answer them for the operator only when one of the operator rules below clearly decides every question.',
    '',
    UNTRUSTED_PREAMBLE,
    '',
    'Operator rules, numbered (written by the operator):',
    ...plainRules.map((rule, index) => `${index + 1}. ${rule}`),
    '',
    'Each question item has a ref and holds the question with its options as JSON; the task-title item is what the session is working on.',
    'Pick option labels exactly as the question writes them: one label for a question whose multiSelect is false, one or more when it is true.',
    'Never write your own text as an answer and never answer from your own preference.',
    'You cannot see the project: decide only from the rules, the questions and the task title, and pass the question on when a rule depends on anything else.',
    `Use the Write tool to write ${resultPath} as JSON and nothing else:`,
    '{"rule": <the number of the one rule that decides>, "answers": [{"question": "<the question ref>", "labels": ["<exact option label>"]}]}',
    'with one answers entry for every question. When no rule clearly decides every question, write {"escalate": "<one short reason>"} instead.',
  ].join('\n');
  const questionItems = questions.map((question, index) => ({ kind: 'agent-question', ref: questionRef(index), text: JSON.stringify(question).slice(0, MANAGER_ITEM_CHARS) }));
  const titleItems = task.title ? [{ kind: 'session-task-title', ref: 'task-title', text: task.title.slice(0, MANAGER_ITEM_CHARS) }] : [];
  return { prompt, untrustedItems: [...questionItems, ...titleItems] };
}

function escalation(reason: string): ManagerVerdict {
  return { kind: 'escalate', reason: reason.slice(0, MANAGER_REASON_CHARS) };
}

export function parseManagerVerdict(raw: unknown, questions: readonly ConversationQuestion[], plainRules: readonly string[]): ManagerVerdict {
  const parsed = ManagerLaneResult.safeParse(raw);
  if (!parsed.success) return escalation('the manager wrote no usable answer');
  if ('escalate' in parsed.data) return escalation(`the manager passed it on: ${parsed.data.escalate}`);
  const rule = plainRules[parsed.data.rule - 1];
  if (rule === undefined) return escalation('the manager cited no operator rule');
  const answers: ConversationAnswers = {};
  for (const [index, question] of questions.entries()) {
    const picks = parsed.data.answers.find((answer) => answer.question === questionRef(index))?.labels;
    const labels = picks ? exactLabels(question, picks) : null;
    if (!labels) return escalation('the manager did not pick exact option labels for every question');
    answers[question.question] = labels.join(MULTI_SELECT_SEPARATOR);
  }
  return { kind: 'answer', answers, ruleName: `rule ${parsed.data.rule}: ${rule}`.slice(0, MANAGER_RULE_NAME_CHARS), by: 'manager' };
}

export {
  MANAGER_BOOTSTRAP_PROMPT, MANAGER_ITEM_CHARS, MANAGER_PROMPT_FILENAME, MANAGER_RESULT_FILENAME, MANAGER_TIMEOUT_MS, MANAGER_UNTRUSTED_SOURCE, NO_RULE_REASON,
};

function answeredQuestionsText(verdict: ManagerAnswer): string {
  return Object.entries(verdict.answers).map(([question, answer]) => `${question}: ${answer}`).join('; ');
}

export function questionToolDenyReason(verdict: ManagerAnswer): string {
  return `The operator's question manager answered: ${answeredQuestionsText(verdict)}. Treat this as the operator's choice and continue without asking again.`;
}

export function answeredSummary(verdict: ManagerAnswer): string {
  return `${answeredQuestionsText(verdict)} (rule: ${verdict.ruleName})`;
}
