const MANAGER_ANSWER_PREFIX = "The operator's question manager answered: ";
const OPERATOR_ANSWER_PREFIX = 'The operator answered in Glimmervoid: ';
const ANSWER_REASON_SUFFIX = ". Treat this as the operator's choice and continue without asking again.";
const ANSWER_SEPARATOR = '; ';

function answeredQuestionsText(answers: Readonly<Record<string, string>>): string {
  return Object.entries(answers).map(([question, answer]) => `${question}: ${answer}`).join(ANSWER_SEPARATOR);
}

function managerAnswerReason(answers: Readonly<Record<string, string>>): string {
  return `${MANAGER_ANSWER_PREFIX}${answeredQuestionsText(answers)}${ANSWER_REASON_SUFFIX}`;
}

function operatorAnswerReason(answers: Readonly<Record<string, string>>): string {
  return `${OPERATOR_ANSWER_PREFIX}${answeredQuestionsText(answers)}${ANSWER_REASON_SUFFIX}`;
}

function answersInReason(reasonText: string, askedQuestions: readonly string[]): Map<string, string> {
  const prefix = [MANAGER_ANSWER_PREFIX, OPERATOR_ANSWER_PREFIX].find((candidate) => reasonText.includes(candidate));
  const answerByQuestion = new Map<string, string>();
  if (prefix === undefined) return answerByQuestion;
  const bodyStart = reasonText.indexOf(prefix) + prefix.length;
  const suffixAt = reasonText.indexOf(ANSWER_REASON_SUFFIX, bodyStart);
  const body = reasonText.slice(bodyStart, suffixAt === -1 ? undefined : suffixAt);
  const starts = askedQuestions.map((question) => ({ question, at: body.indexOf(`${question}: `) })).filter((start) => start.at !== -1).sort((left, right) => left.at - right.at);
  for (const [index, start] of starts.entries()) {
    const answerStart = start.at + start.question.length + 2;
    const nextStart = starts[index + 1]?.at;
    const answerEnd = nextStart === undefined ? body.length : nextStart - ANSWER_SEPARATOR.length;
    answerByQuestion.set(start.question, body.slice(answerStart, Math.max(answerStart, answerEnd)));
  }
  return answerByQuestion;
}

export { answersInReason, answeredQuestionsText, managerAnswerReason, operatorAnswerReason };
