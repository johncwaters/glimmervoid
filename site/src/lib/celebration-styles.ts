const CELEBRATION_SELECTOR_MARKERS = ['.merge-', '.celebration-tray', '.btn-celebrations'];
const DASHBOARD_ONLY_SELECTOR_MARKERS = ['.phone-topbar', '[data-layout'];
const REQUIRED_RULE_MARKER = '.merge-celebration-card';

interface TopLevelBlock { prelude: string; body: string }

function splitTopLevelBlocks(stylesheet: string): TopLevelBlock[] {
  const blocks: TopLevelBlock[] = [];
  let depth = 0;
  let preludeStart = 0;
  let bodyStart = 0;
  for (let index = 0; index < stylesheet.length; index += 1) {
    const character = stylesheet[index];
    if (character === '{') {
      if (depth === 0) bodyStart = index + 1;
      depth += 1;
      continue;
    }
    if (character !== '}') continue;
    depth -= 1;
    if (depth !== 0) continue;
    blocks.push({ prelude: stylesheet.slice(preludeStart, bodyStart - 1).trim(), body: stylesheet.slice(bodyStart, index) });
    preludeStart = index + 1;
  }
  return blocks;
}

function isCelebrationSelector(selector: string): boolean {
  if (DASHBOARD_ONLY_SELECTOR_MARKERS.some((marker) => selector.includes(marker))) return false;
  return CELEBRATION_SELECTOR_MARKERS.some((marker) => selector.includes(marker));
}

function celebrationRulesWithin(stylesheet: string): string[] {
  return splitTopLevelBlocks(stylesheet).map(celebrationRuleOf).filter((rule): rule is string => rule !== null);
}

function celebrationRuleOf(block: TopLevelBlock): string | null {
  if (block.prelude.startsWith('@keyframes')) return block.prelude.startsWith('@keyframes merge-') ? `${block.prelude} {${block.body}}` : null;
  if (block.prelude.startsWith('@')) {
    const innerRules = celebrationRulesWithin(block.body);
    return innerRules.length === 0 ? null : `${block.prelude} {\n${innerRules.join('\n')}\n}`;
  }
  const celebrationSelectors = block.prelude.split(',').map((selector) => selector.trim()).filter(isCelebrationSelector);
  if (celebrationSelectors.length === 0) return null;
  return `${celebrationSelectors.join(',\n')} {${block.body}}`;
}

export function extractCelebrationStyles(dashboardStylesheet: string): string {
  const rules = celebrationRulesWithin(dashboardStylesheet);
  if (!rules.some((rule) => rule.includes(REQUIRED_RULE_MARKER))) throw new Error(`public/style.css no longer has a ${REQUIRED_RULE_MARKER} rule`);
  return rules.join('\n');
}
