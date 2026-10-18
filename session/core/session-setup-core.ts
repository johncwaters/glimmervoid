import { z } from 'zod';
import type { SessionSetup } from '../../shared/contracts/session-setup.ts';

const nameDelta = { addedNames: z.array(z.string()), removedNames: z.array(z.string()).optional() };
const hookFields = { hookName: z.string(), hookEvent: z.string() };
const transcriptSetupLine = z.union([
  z.object({
    type: z.literal('attachment'),
    attachment: z.discriminatedUnion('type', [
      z.object({ type: z.literal('mcp_instructions_delta'), ...nameDelta }),
      z.object({ type: z.literal('deferred_tools_delta'), ...nameDelta }),
      z.object({ type: z.literal('skill_listing'), content: z.string(), isInitial: z.boolean().optional(), names: z.array(z.string()).optional() }),
      z.object({ type: z.literal('agent_listing_delta'), addedTypes: z.array(z.string()), removedTypes: z.array(z.string()).optional() }),
      z.object({ type: z.literal('hook_success'), ...hookFields }),
      z.object({ type: z.literal('hook_non_blocking_error'), ...hookFields }),
      z.object({ type: z.literal('model'), identity: z.object({ modelId: z.string(), marketingName: z.string() }) }),
    ]),
  }),
  z.object({ type: z.literal('system'), subtype: z.literal('stop_hook_summary'), hookInfos: z.array(z.object({ command: z.string() })) }),
]);

function applyDelta(names: Set<string>, addedNames: string[], removedNames: string[] = []) {
  for (const name of addedNames) names.add(name);
  for (const name of removedNames) names.delete(name);
}

function listedSkillNames(listing: { content: string; names?: string[] | undefined }): string[] {
  if (listing.names) return listing.names;
  return [...listing.content.matchAll(/^- (\S+):\s/gm)].map((match) => match[1]);
}

function sortedNames(names: Iterable<string>): string[] {
  return [...new Set(names)].sort();
}

function serverKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export function createSessionSetupFold() {
  let model: string | null = null;
  let skills = new Set<string>();
  const agents = new Set<string>();
  const mcpServers = new Set<string>();
  const deferredTools = new Set<string>();
  const hookCounts = new Map<string, number>();
  const hookCommands = new Set<string>();

  function ingestLine(rawLine: string): void {
    if (!rawLine.includes('"attachment"') && !rawLine.includes('stop_hook_summary')) return;
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(rawLine);
    } catch {
      return;
    }
    const parsedSetupLine = transcriptSetupLine.safeParse(parsedLine);
    if (!parsedSetupLine.success) return;
    const setupLine = parsedSetupLine.data;
    if (setupLine.type === 'system') {
      for (const hook of setupLine.hookInfos) hookCommands.add(hook.command);
      return;
    }
    const attachment = setupLine.attachment;
    switch (attachment.type) {
      case 'mcp_instructions_delta':
        applyDelta(mcpServers, attachment.addedNames, attachment.removedNames);
        return;
      case 'deferred_tools_delta':
        applyDelta(deferredTools, attachment.addedNames, attachment.removedNames);
        return;
      case 'agent_listing_delta':
        applyDelta(agents, attachment.addedTypes, attachment.removedTypes);
        return;
      case 'skill_listing':
        if (attachment.isInitial !== false) skills = new Set();
        for (const skillName of listedSkillNames(attachment)) skills.add(skillName);
        return;
      case 'model':
        model = attachment.identity.marketingName || attachment.identity.modelId;
        return;
      case 'hook_success':
      case 'hook_non_blocking_error':
        hookCounts.set(attachment.hookEvent, (hookCounts.get(attachment.hookEvent) ?? 0) + 1);
        return;
    }
  }

  function snapshot(): SessionSetup {
    const pluginsByName = new Map<string, SessionSetup['plugins'][number]>();
    function standaloneNames(names: Set<string>, kind: 'skills' | 'agents'): string[] {
      const standalone: string[] = [];
      for (const name of sortedNames(names)) {
        const separatorIndex = name.indexOf(':');
        if (separatorIndex <= 0) {
          standalone.push(name);
          continue;
        }
        const pluginName = name.slice(0, separatorIndex);
        const plugin = pluginsByName.get(pluginName) ?? { name: pluginName, skills: [], agents: [] };
        plugin[kind].push(name.slice(separatorIndex + 1));
        pluginsByName.set(pluginName, plugin);
      }
      return standalone;
    }
    const standaloneSkills = standaloneNames(skills, 'skills');
    const standaloneAgents = standaloneNames(agents, 'agents');
    const displayServerKeys = new Set([...mcpServers].map(serverKey));
    const toolServers = [...deferredTools].flatMap((name) => {
      const toolServer = /^mcp__(.+?)__.+$/.exec(name)?.[1];
      return toolServer && !displayServerKeys.has(serverKey(toolServer)) ? [toolServer] : [];
    });
    return {
      model,
      mcpServers: sortedNames([...mcpServers, ...toolServers]),
      plugins: sortedNames(pluginsByName.keys()).flatMap((name) => {
        const plugin = pluginsByName.get(name);
        return plugin ? [plugin] : [];
      }),
      skills: standaloneSkills,
      agents: standaloneAgents,
      hookEvents: sortedNames(hookCounts.keys()).map((event) => ({ event, runCount: hookCounts.get(event) ?? 0 })),
      hookCommands: sortedNames(hookCommands),
    };
  }

  return { ingestLine, snapshot };
}
