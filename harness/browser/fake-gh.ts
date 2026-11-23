import fs from 'node:fs';
import { FAKE_PR_NUMBER, FAKE_PR_REPO, fakePrNodeOf } from './fake-pr.ts';
import type { FakePrState } from './fake-pr.ts';

const [statePath = '', ...args] = process.argv.slice(2);
const VIEWER_LOGIN = 'me';
const ALIASED_PR_RE = /(pr\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/g;

function readState(): FakePrState | null {
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, 'utf8')) as FakePrState;
}

function queryOf(argv: readonly string[]): string {
  const field = argv.find((arg) => arg.startsWith('query='));
  return field ? field.slice('query='.length) : '';
}

function graphqlAnswerOf(query: string): Record<string, unknown> {
  const state = readState();
  const answerFields: Record<string, unknown> = { rateLimit: { cost: 1 } };
  for (const [, alias, owner, name, numberText] of query.matchAll(ALIASED_PR_RE)) {
    const isFakePr = state !== null && `${owner}/${name}`.toLowerCase() === FAKE_PR_REPO.toLowerCase() && Number(numberText) === FAKE_PR_NUMBER;
    answerFields[alias ?? ''] = { pullRequest: isFakePr ? fakePrNodeOf(state) : null };
  }
  if (query.includes('search(')) {
    const nodes = state === null ? [] : [fakePrNodeOf(state)];
    answerFields.search = { issueCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes };
  }
  if (query.includes('viewer')) answerFields.viewer = { login: VIEWER_LOGIN };
  return answerFields;
}

function answer(argv: readonly string[]): string {
  if (argv[0] === 'auth' && argv[1] === 'token') return 'fake-gh-token';
  if (argv[0] !== 'api') return '';
  if (argv.includes('graphql')) return JSON.stringify({ data: graphqlAnswerOf(queryOf(argv)) });
  if (argv.includes('user')) return argv.includes('--jq') ? VIEWER_LOGIN : JSON.stringify({ login: VIEWER_LOGIN });
  return '{}';
}

process.stdout.write(`${answer(args)}\n`);
