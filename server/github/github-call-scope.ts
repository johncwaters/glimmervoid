import { AsyncLocalStorage } from 'node:async_hooks';

import type { GithubCallTrigger } from '../../shared/contracts/github-usage.ts';
import { UNATTRIBUTED_OPERATION } from './core/github-usage-core.ts';

type GithubCallScope = { operation: string; trigger: GithubCallTrigger };

const UNSCOPED_TRIGGER: GithubCallTrigger = 'lane';
const callScope = new AsyncLocalStorage<GithubCallScope>();

function currentGithubCallScope(): GithubCallScope {
  return callScope.getStore() ?? { operation: UNATTRIBUTED_OPERATION, trigger: UNSCOPED_TRIGGER };
}

function withGithubOperation<Value>(operation: string, work: () => Value): Value {
  return callScope.run({ operation, trigger: currentGithubCallScope().trigger }, work);
}

function withGithubTrigger<Value>(trigger: GithubCallTrigger, work: () => Value): Value {
  return callScope.run({ operation: currentGithubCallScope().operation, trigger }, work);
}

export { currentGithubCallScope, withGithubOperation, withGithubTrigger };
