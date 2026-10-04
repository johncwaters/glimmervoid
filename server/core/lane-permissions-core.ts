const ACCEPT_EDITS_MODE = 'acceptEdits';

const LANE_CONFIG_EDIT_DENY_RULES: readonly string[] = Object.freeze([
  'Edit(**/.git/**)',
  'Edit(**/.claude/**)',
]);

const LANE_ENVIRONMENT_ARGS: readonly string[] = Object.freeze([
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--setting-sources', 'project,local',
]);

export interface LanePermissions {
  permissions: { deny: string[]; defaultMode: string };
  args: string[];
}

function buildLanePermissions({
  denyTools = [],
  allowTools = [],
}: { denyTools?: readonly string[]; allowTools?: readonly string[] } = {}): LanePermissions {
  const args: string[] = [];
  if (allowTools.length > 0) args.push('--tools', allowTools.join(','));
  args.push(...LANE_ENVIRONMENT_ARGS);
  return { permissions: { deny: [...denyTools], defaultMode: ACCEPT_EDITS_MODE }, args };
}

export { ACCEPT_EDITS_MODE, LANE_CONFIG_EDIT_DENY_RULES, LANE_ENVIRONMENT_ARGS, buildLanePermissions };
