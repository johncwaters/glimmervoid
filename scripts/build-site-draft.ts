import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(import.meta.dirname, '..');
const websiteDirectory = path.join(repoRoot, 'docs', 'website');
const templatePath = path.join(websiteDirectory, 'draft.template.html');
const outputPath = path.join(repoRoot, 'dist', 'site-draft.html');
const dashboardStylesheetPath = path.join(repoRoot, 'public', 'style.css');

const ANIMALS_PLACEHOLDER = '/*__ANIMALS_CSS__*/';
const DASHBOARD_FLIGHT_SCOPE = ':root[data-flying-animals="true"] .nyan';
const SITE_FLIGHT_SCOPE = '.sky .nyan';
const FIRST_ANIMAL_RULE = `${DASHBOARD_FLIGHT_SCOPE}-flight {`;
const REDUCED_MOTION_OPENER = '@media (prefers-reduced-motion: reduce) {';
const PHONE_ONLY_RULE = /html\[data-layout="phone"\]\[data-flying-animals="true"\] \.nyan-flight \{[^}]*\}\n/g;

export function extractAnimalStyles(dashboardStylesheet: string): string {
  const lines = dashboardStylesheet.split('\n');
  const firstLineIndex = lines.indexOf(FIRST_ANIMAL_RULE);
  if (firstLineIndex < 0) throw new Error(`public/style.css no longer has the line: ${FIRST_ANIMAL_RULE}`);
  const endLineIndex = lines.findIndex(
    (line, index) => index > firstLineIndex && line === REDUCED_MOTION_OPENER && lines[index + 1]?.trim() === FIRST_ANIMAL_RULE,
  );
  if (endLineIndex < 0) throw new Error('public/style.css no longer closes the flying animals block with its reduced-motion rule');
  return lines
    .slice(firstLineIndex, endLineIndex)
    .join('\n')
    .replaceAll(DASHBOARD_FLIGHT_SCOPE, SITE_FLIGHT_SCOPE)
    .replace(PHONE_ONLY_RULE, '');
}

export function buildSiteDraft(template: string, animalStyles: string): string {
  if (template.split(ANIMALS_PLACEHOLDER).length !== 2) throw new Error(`template must hold exactly one ${ANIMALS_PLACEHOLDER}`);
  return template.replace(ANIMALS_PLACEHOLDER, () => animalStyles);
}

if (process.argv[1] === import.meta.filename) {
  const animalStyles = extractAnimalStyles(fs.readFileSync(dashboardStylesheetPath, 'utf8'));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buildSiteDraft(fs.readFileSync(templatePath, 'utf8'), animalStyles));
  process.stdout.write(`${path.relative(repoRoot, outputPath)}\n`);
}
