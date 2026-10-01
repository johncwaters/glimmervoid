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
