import path from 'node:path';

function isUnder(child: unknown, parent: unknown): boolean {
  if (typeof child !== 'string' || typeof parent !== 'string' || !child || !parent) return false;
  const from = path.resolve(parent);
  const to = path.resolve(child);
  const relative = path.relative(from, to);
  if (relative === '') return true;
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
  return true;
}

function underTestRunner(env: { NODE_TEST_CONTEXT?: string } | null | undefined): boolean {
  const marker = env ? env.NODE_TEST_CONTEXT : undefined;
  return typeof marker === 'string' && marker !== '';
}

export { isUnder, underTestRunner };
