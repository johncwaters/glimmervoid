import { FindingSeverity, ReviewFinding, ReviewVerdict } from '../../../shared/contracts/team-review.ts';
import { SessionReviewAgent } from '../../../shared/contracts/session-review.ts';
import { UNTRUSTED_PAYLOAD_FILENAME, UNTRUSTED_PREAMBLE } from '../../../shared/contracts/untrusted-payload.ts';
import { isRecord } from '../../../shared/coerce.ts';
import { parseReviewReport } from '../../github/core/team-review-core.ts';

const SESSION_REVIEW_PROMPT_FILENAME = 'session-review-prompt.txt';
const SESSION_REVIEW_REPORT_FILENAME = 'session-review.md';
const SESSION_REVIEW_BOOTSTRAP_PROMPT = `Read ${SESSION_REVIEW_PROMPT_FILENAME} and follow all instructions in that file`;
const SESSION_REVIEW_UNTRUSTED_SOURCE = 'session-review';
const SESSION_REVIEW_DIFF_MAX_CHARS = 400_000;
const SESSION_REVIEW_REPORT_MAX_BYTES = 512 * 1024;
const SESSION_REVIEW_TIMEOUT_MS = 20 * 60_000;
const SESSION_REVIEW_MODEL_MAX_CHARS = 200;
const PLACEHOLDER_HEAD = '0'.repeat(40);

interface SessionReviewer {
  agent: SessionReviewAgent;
  model: string | null;
}

function readSessionReviewer(raw: unknown): SessionReviewer {
  const block = isRecord(raw) ? raw : {};
  const agent = SessionReviewAgent.safeParse(block.agent);
  const model = typeof block.model === 'string' ? block.model.trim().slice(0, SESSION_REVIEW_MODEL_MAX_CHARS) : '';
  return { agent: agent.success ? agent.data : 'claude-code', model: model.length > 0 ? model : null };
}

function checkoutAccessLines(reviewer: SessionReviewer, worktreeDir: string): string[] {
  if (reviewer.agent === 'claude-code') return [`The session's checkout is ${worktreeDir}. Read its files with Read, Glob and Grep to check a finding; never edit it.`];
  return ['You cannot read the session\'s checkout, only the diff. Judge from the diff, and name in OVERALL_SUMMARY what you could not check without the surrounding code.'];
}

function diffCutLines(diffChars: number): string[] {
  if (diffChars <= SESSION_REVIEW_DIFF_MAX_CHARS) return [];
  return [`The diff is ${diffChars} characters and the item holds only its first ${SESSION_REVIEW_DIFF_MAX_CHARS}, so later files are missing. Never approve: the verdict is at best REQUEST CHANGES, and OVERALL_SUMMARY says the review is partial.`];
}

function buildSessionReviewPrompt({ worktreeDir, reportPath, reviewer, diffChars }: { worktreeDir: string; reportPath: string; reviewer: SessionReviewer; diffChars: number }): string {
  return [
    'You are an independent reviewer of a coding session\'s uncommitted and unmerged work. Another agent wrote it; you did not.',
    UNTRUSTED_PREAMBLE,
    `The single item in ${UNTRUSTED_PAYLOAD_FILENAME} is the session's diff against its base branch.`,
    ...diffCutLines(diffChars),
    ...checkoutAccessLines(reviewer, worktreeDir),
    'Find what the diff gets wrong: logic defects, broken callers, missing error handling at boundaries, security holes,',
    'and tests that do not test the change. Report only what you can point at in the code. Skip style preferences.',
    '',
    `Report file: use the Write tool to write ${reportPath} with exactly this layout and nothing else:`,
    `- first line: VERDICT: <one of ${ReviewVerdict.options.join(', ')}>`,
    '- then one blank line',
    '- then one line: STRUCTURED_FINDINGS:',
    '- then one line per finding, in exactly this form:',
    '  - file: <path> | line: <line> | side: RIGHT | severity: <severity> | reviewer: <label> | disposition: <disposition> | body: <body>',
    '  where <path> is relative to the checkout root, <line> is a positive line number or the word general,',
    `  <severity> is one of ${FindingSeverity.options.join(', ')}, <label> is a short tag with no | character,`,
    `  <disposition> is one of ${ReviewFinding.shape.disposition.unwrap().options.join(', ')}, and <body> is the problem and its fix on one line.`,
    '  Write the single line (none) when there are no findings.',
    '- then one blank line',
    '- then one line: OVERALL_SUMMARY:',
    '- then one or two plain sentences on why the verdict follows from the findings.',
    'If the review cannot complete, still write the file, with the line VERDICT: FAILED in place of a verdict.',
  ].join('\n');
}

const APPROVING_VERDICTS: ReadonlySet<ReviewVerdict> = new Set(['APPROVE', 'APPROVE WITH NITS']);

function boundedToSeenDiff(outcome: { verdict: ReviewVerdict; summary: string }, diffChars: number): { verdict: ReviewVerdict; summary: string } {
  if (diffChars <= SESSION_REVIEW_DIFF_MAX_CHARS) return outcome;
  const note = `Partial review: the reviewer saw the first ${SESSION_REVIEW_DIFF_MAX_CHARS} of ${diffChars} characters of the diff.`;
  return { verdict: APPROVING_VERDICTS.has(outcome.verdict) ? 'REQUEST CHANGES' : outcome.verdict, summary: [note, outcome.summary].filter((part) => part.length > 0).join(' ') };
}

type SessionReviewOutcome =
  | { ok: true; verdict: ReviewVerdict; summary: string; findings: ReviewFinding[] }
  | { ok: false; reason: string };

function parseSessionReviewReport(report: string | null): SessionReviewOutcome {
  if (report === null) return { ok: false, reason: 'the reviewer wrote no report' };
  const withoutHeadLines = report.split(/\r?\n/).filter((line) => !/^HEAD_SHA:/.test(line)).join('\n');
  const parsed = parseReviewReport(`HEAD_SHA: ${PLACEHOLDER_HEAD}\n\n${withoutHeadLines}`);
  if (!parsed.ok) return parsed;
  return { ok: true, verdict: parsed.result.verdict, summary: parsed.result.summary, findings: parsed.result.findings };
}

export {
  SESSION_REVIEW_BOOTSTRAP_PROMPT, SESSION_REVIEW_DIFF_MAX_CHARS, SESSION_REVIEW_PROMPT_FILENAME, SESSION_REVIEW_REPORT_FILENAME,
  SESSION_REVIEW_REPORT_MAX_BYTES, SESSION_REVIEW_TIMEOUT_MS, SESSION_REVIEW_UNTRUSTED_SOURCE,
  boundedToSeenDiff, buildSessionReviewPrompt, parseSessionReviewReport, readSessionReviewer,
};
export type { SessionReviewer };
