const DEMO_SELECTOR_MARKERS = ['.merge-', '.celebration-tray', '.btn-celebrations', '.attention-banner', '.attention-tile', '.session-row-attention-tab', '.session-row[data-tethered]', '.status-icon'];
const DEMO_KEYFRAME_PREFIXES = ['@keyframes merge-', '@keyframes attention-', '@keyframes status-icon-'];
const DASHBOARD_ONLY_SELECTOR_MARKERS = ['.phone-topbar', '[data-layout'];
const REQUIRED_RULE_MARKERS = ['.merge-celebration-card', '.attention-banner', '.session-row-attention-tab'];

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

function isDemoSelector(selector: string): boolean {
  if (DASHBOARD_ONLY_SELECTOR_MARKERS.some((marker) => selector.includes(marker))) return false;
  return DEMO_SELECTOR_MARKERS.some((marker) => selector.includes(marker));
}

function demoRulesWithin(stylesheet: string): string[] {
  return splitTopLevelBlocks(stylesheet).map(demoRuleOf).filter((rule): rule is string => rule !== null);
}

function demoRuleOf(block: TopLevelBlock): string | null {
  if (block.prelude.startsWith('@keyframes')) return DEMO_KEYFRAME_PREFIXES.some((prefix) => block.prelude.startsWith(prefix)) ? `${block.prelude} {${block.body}}` : null;
  if (block.prelude.startsWith('@')) {
    const innerRules = demoRulesWithin(block.body);
    return innerRules.length === 0 ? null : `${block.prelude} {\n${innerRules.join('\n')}\n}`;
  }
  const demoSelectors = block.prelude.split(',').map((selector) => selector.trim()).filter(isDemoSelector);
  if (demoSelectors.length === 0) return null;
  return `${demoSelectors.join(',\n')} {${block.body}}`;
}

export function extractDemoStyles(dashboardStylesheet: string): string {
  const rules = demoRulesWithin(dashboardStylesheet);
  const missingMarker = REQUIRED_RULE_MARKERS.find((marker) => !rules.some((rule) => rule.includes(marker)));
  if (missingMarker) throw new Error(`public/style.css no longer has a ${missingMarker} rule`);
  return rules.join('\n');
}
