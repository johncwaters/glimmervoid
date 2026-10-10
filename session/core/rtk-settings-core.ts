import type { ResolvedHookTool } from './hook-tools.ts';

function refreshRtkHookTools(originalTools: readonly ResolvedHookTool[], currentTools: readonly ResolvedHookTool[]): ResolvedHookTool[] {
  const currentRtkTool = currentTools.find(tool => tool.id === 'rtk');
  if (!currentRtkTool) return originalTools.filter(tool => tool.id !== 'rtk');
  if (!originalTools.some(tool => tool.id === 'rtk')) return [currentRtkTool, ...originalTools];
  return originalTools.map(tool => tool.id === 'rtk' ? currentRtkTool : tool);
}

export { refreshRtkHookTools };
