import { z } from 'zod';
import { CatalogAgentId, SAFE_LAUNCH_ARGUMENT_PATTERN } from './agent-models.ts';

const LaunchValue = z.string().regex(SAFE_LAUNCH_ARGUMENT_PATTERN, { error: 'a model or effort uses only letters, digits and . _ : / [ ] -, because it reaches the agent command line' });

const LAUNCH_PROJECT_PATTERN = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|\/.+|[A-Za-z]:[\\/].*)$/;

export const LauncherLabel = z.string().trim().regex(/^[A-Za-z0-9_\-. ()]{1,24}$/, { error: 'a launcher label is 1 to 24 letters, digits, spaces and _ - . ( )' });
export const LauncherProject = z.string().max(4096).regex(LAUNCH_PROJECT_PATTERN, { error: 'a launcher project is an owner/name GitHub repository or an absolute folder path' });
export const LaunchAgent = CatalogAgentId.describe('The agent the session runs');
export const LaunchModel = LaunchValue.max(200).optional().describe('The model passed to the agent, as its own --model flag takes it; absent uses the agent default');
export const LaunchEffort = LaunchValue.max(40).optional().describe('The reasoning effort passed to the agent, such as low, medium or high; absent uses the agent default');
export const LaunchPrompt = z.string().trim().min(1).max(4000).regex(/^[\P{C}\n\t]*$/u, { error: 'a launcher prompt holds no control, format or invisible characters besides newlines and tabs, so the operator approves exactly what the session gets' }).describe('The first prompt the session gets');

export const PackSessionStart = z.strictObject({
  project: LauncherProject.describe('owner/name: the first configured project whose origin is that GitHub repository; or an absolute path of a folder on this machine'),
  agent: LaunchAgent, model: LaunchModel, effort: LaunchEffort, prompt: LaunchPrompt,
  name: LauncherLabel.optional().describe('The session name; absent uses the panel label'),
});
export type PackSessionStart = z.infer<typeof PackSessionStart>;
