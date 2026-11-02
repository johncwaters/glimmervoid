const SUPERVISED_RESTART_EXIT_CODE = 75;

function decideRestartStrategy(env: Record<string, string | undefined> | null | undefined): 'respawn' | 'exit-for-supervisor' {
  if (!env) return 'respawn';
  if (env.INVOCATION_ID) return 'exit-for-supervisor';
  if (env.GLIMMERVOID_SUPERVISOR === 'launchd') return 'exit-for-supervisor';
  return 'respawn';
}

export { decideRestartStrategy, SUPERVISED_RESTART_EXIT_CODE };
