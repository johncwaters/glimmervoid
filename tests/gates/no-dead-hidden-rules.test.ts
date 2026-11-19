import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readTracked, trackedFiles } from '../helpers/tracked-files.ts';

interface StyleRule {
  selectorChain: string[];
  declarations: string[];
}

const HIDDEN_ATTRIBUTE = /\[\s*hidden\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*))\s*)?(?:\s[is])?\s*\]/gi;

const withoutComments = (stylesheet: string) => stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');
const withoutNegations = (selector: string) => selector.replace(/:not\([^()]*\)/g, '');

function targetsHidden(selector: string): boolean {
  return [...withoutNegations(selector).matchAll(HIDDEN_ATTRIBUTE)].some((match) => (match[1] ?? match[2] ?? match[3] ?? '') !== 'until-found');
}

function styleRulesOf(stylesheet: string): StyleRule[] {
  const rules: StyleRule[] = [];
  const openRules: StyleRule[] = [];
  let pendingText = '';
  for (const character of stylesheet) {
    if (character === '{') {
      openRules.push({ selectorChain: [...(openRules.at(-1)?.selectorChain ?? []), pendingText.trim()], declarations: [] });
      pendingText = '';
      continue;
    }
    if (character === ';' || character === '}') {
      const declaration = pendingText.trim().replace(/\s+/g, ' ');
      if (declaration !== '') openRules.at(-1)?.declarations.push(declaration);
      pendingText = '';
      if (character === '}') {
        const closedRule = openRules.pop();
        if (closedRule) rules.push(closedRule);
      }
      continue;
    }
    pendingText += character;
  }
  return rules;
}

function deadHiddenRulesIn(repoPath: string): string[] {
  return styleRulesOf(withoutComments(readTracked(repoPath))).flatMap((rule) => {
    if (!rule.selectorChain.some(targetsHidden)) return [];
    const deadDeclarations = rule.declarations.filter((declaration) => declaration !== 'display: none');
    return deadDeclarations.length > 0 ? [`${repoPath}: ${rule.selectorChain.join(' > ')} { ${deadDeclarations.join('; ')} }`] : [];
  });
}

test('a [hidden] rule declares only display: none, since Tailwind preflight forces display none !important on [hidden]', () => {
  const deadRules = trackedFiles(/^public\/.*\.css$/).flatMap(deadHiddenRulesIn);
  assert.deepEqual(deadRules, []);
});
