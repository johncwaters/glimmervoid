import path from 'node:path';
import type { ConversationAnswers, ConversationQuestion } from '../../../shared/contracts/session.ts';
import type { ManagerAnswer, ManagerVerdict, QuestionManagerSettings, QuestionRule } from '../../../shared/contracts/question-manager.ts';

interface SessionRepo {
  path: string;
  slug: string | null;
}

const MULTI_SELECT_SEPARATOR = ', ';
const GITHUB_SLUG_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const HIGH_RISK_STEMS = [
  'push', 'forc', 'delet', 'remov', 'drop', 'deploy', 'publish', 'releas', 'merg', 'secret', 'token', 'password',
  'credential', 'reset', 'revert', 'rebas', 'destro', 'wip', 'purg', 'truncat', 'overwrit', 'production', 'rm',
];
const HIGH_RISK_PATTERN = new RegExp(`\\b(?:${HIGH_RISK_STEMS.join('|')})\\w*`, 'i');

function isSlugEntry(entry: string): boolean {
  return GITHUB_SLUG_PATTERN.test(entry) && !entry.startsWith('.');
}

export function needsRepoSlug(settings: QuestionManagerSettings): boolean {
  return (settings.repos ?? []).some(isSlugEntry);
}

export function mightAnswer(settings: QuestionManagerSettings | null | undefined): boolean {
  if (!settings) return false;
  if ((settings.rules ?? []).length === 0) return false;
  return settings.enabled === true || (settings.repos ?? []).length > 0;
}

function expandedPath(entry: string, homeDir: string): string {
  if (entry === '~') return homeDir;
  if (entry.startsWith('~/') || entry.startsWith('~\\')) return path.join(homeDir, entry.slice(2));
  return path.resolve(entry);
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isRepoListed(entry: string, repo: SessionRepo, homeDir: string): boolean {
  if (isSlugEntry(entry)) return repo.slug !== null && repo.slug.toLowerCase() === entry.toLowerCase();
  return isPathInside(path.resolve(repo.path), expandedPath(entry, homeDir));
}

export function isManagerOn(settings: QuestionManagerSettings, repo: SessionRepo, homeDir: string): boolean {
  const isListed = (settings.repos ?? []).some((entry) => isRepoListed(entry, repo, homeDir));
  return (settings.enabled === true) !== isListed;
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

function pickedLabels(question: ConversationQuestion, rule: QuestionRule): string[] | null {
  if (!question.question.toLowerCase().includes(rule.question.toLowerCase())) return null;
  if (!question.multiSelect && rule.pick.length > 1) return null;
  const labels = rule.pick.map((pick) => question.options.find((option) => option.label.toLowerCase() === pick.toLowerCase())?.label);
  if (labels.some((label) => label === undefined)) return null;
  return labels.filter((label): label is string => label !== undefined);
}

function matchRules(questions: readonly ConversationQuestion[], rules: readonly QuestionRule[]): ManagerVerdict | null {
  const answers: ConversationAnswers = {};
  const ruleNames: string[] = [];
  for (const question of questions) {
    const matched = rules
      .map((rule) => ({ rule, labels: pickedLabels(question, rule) }))
      .find((candidate) => candidate.labels !== null);
    if (!matched?.labels) return null;
    answers[question.question] = matched.labels.join(MULTI_SELECT_SEPARATOR);
    if (!ruleNames.includes(matched.rule.name)) ruleNames.push(matched.rule.name);
  }
  return { kind: 'answer', answers, ruleName: ruleNames.join(MULTI_SELECT_SEPARATOR), by: 'rule' };
}

export function decideByRules(questions: readonly ConversationQuestion[] | null, settings: QuestionManagerSettings): ManagerVerdict {
  if (!questions || questions.length === 0) return { kind: 'escalate', reason: 'the question could not be read' };
  const riskWord = riskWordIn(questions);
  if (riskWord) return { kind: 'escalate', reason: `risk word "${riskWord}"` };
  return matchRules(questions, settings.rules ?? []) ?? { kind: 'escalate', reason: 'no rule covers this question' };
}

function answeredQuestionsText(verdict: ManagerAnswer): string {
  return Object.entries(verdict.answers).map(([question, answer]) => `${question}: ${answer}`).join('; ');
}

export function questionToolDenyReason(verdict: ManagerAnswer): string {
  return `The operator's question manager answered: ${answeredQuestionsText(verdict)}. Treat this as the operator's choice and continue without asking again.`;
}

export function answeredSummary(verdict: ManagerAnswer): string {
  return `${answeredQuestionsText(verdict)} (rule: ${verdict.ruleName})`;
}
