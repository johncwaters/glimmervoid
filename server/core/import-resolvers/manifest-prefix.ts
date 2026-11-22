import path from 'node:path';

const GO_MODULE_DIRECTIVE = /^\s*module\s+"?([^\s"]+)"?/m;

const MODULE_PATH_READER_BY_MANIFEST: Record<string, (manifestText: string) => string | null> = {
  'go.mod': (manifestText) => GO_MODULE_DIRECTIVE.exec(manifestText)?.[1] ?? null,
};

export function manifestPrefixPatterns(manifestTextByPath: ReadonlyMap<string, string>): Record<string, string[]> {
  const patterns: Record<string, string[]> = {};
  for (const [manifestPath, manifestText] of manifestTextByPath) {
    const readModulePath = MODULE_PATH_READER_BY_MANIFEST[path.posix.basename(manifestPath)];
    const modulePath = readModulePath?.(manifestText);
    if (!modulePath) continue;
    const directory = path.posix.dirname(manifestPath);
    patterns[modulePath] = [...(patterns[modulePath] ?? []), directory];
    patterns[`${modulePath}/*`] = [...(patterns[`${modulePath}/*`] ?? []), directory === '.' ? '*' : `${directory}/*`];
  }
  return patterns;
}
