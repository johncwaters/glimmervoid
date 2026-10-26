import { GithubPrsFrame } from '#shared/contracts/github-prs.ts';
import type { GithubPr } from '#shared/contracts/github-prs.ts';
import { describeSchemaIssues } from '../client-error-core.ts';
import { reportToServerLog } from '../control-ws.ts';

let prsByKey: ReadonlyMap<string, GithubPr> = new Map();
const subscribers = new Set<() => void>();

export function applyGithubPrsFrame(message: unknown): void {
  const parsed = GithubPrsFrame.safeParse(message);
  if (!parsed.success) {
    reportToServerLog('reviews', `dropped github-prs: ${describeSchemaIssues(parsed.error.issues)}`);
    return;
  }
  prsByKey = new Map(Object.entries(parsed.data.prs));
  for (const subscriber of subscribers) subscriber();
}

export function githubPrByKey(key: string): GithubPr | undefined {
  return prsByKey.get(key.toLowerCase());
}

export function subscribeGithubPrs(subscriber: () => void): void {
  subscribers.add(subscriber);
}
