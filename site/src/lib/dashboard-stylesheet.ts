const COMPONENT_LAYER_IMPORT = /^@import "\.\/([^"]+\.css)" layer\(components\);$/gm;

export function joinDashboardStylesheet(entryStylesheet: string, readStylesheet: (publicPath: string) => string | undefined): string {
  const stylesheetPaths = [...entryStylesheet.matchAll(COMPONENT_LAYER_IMPORT)].map((match) => match[1]);
  if (stylesheetPaths.length === 0) throw new Error('public/tailwind.css no longer imports a stylesheet into the components layer');
  return stylesheetPaths.map((stylesheetPath) => {
    const stylesheet = readStylesheet(stylesheetPath);
    if (stylesheet === undefined) throw new Error(`public/tailwind.css imports public/${stylesheetPath}, which could not be read`);
    return stylesheet;
  }).join('\n');
}
