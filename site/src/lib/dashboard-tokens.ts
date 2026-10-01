const ROOT_BLOCK_OPENER = ':root {';
const TOP_LEVEL_BLOCK_CLOSER = '}';

export function extractDashboardTokens(dashboardStylesheet: string): string {
  const lines = dashboardStylesheet.split('\n');
  const openerLineIndex = lines.indexOf(ROOT_BLOCK_OPENER);
  if (openerLineIndex < 0) throw new Error(`public/style.css no longer has the line: ${ROOT_BLOCK_OPENER}`);
  const closerLineIndex = lines.findIndex((line, index) => index > openerLineIndex && line === TOP_LEVEL_BLOCK_CLOSER);
  if (closerLineIndex < 0) throw new Error('public/style.css no longer closes its first :root block at the top level');
  return lines.slice(openerLineIndex, closerLineIndex + 1).join('\n');
}
