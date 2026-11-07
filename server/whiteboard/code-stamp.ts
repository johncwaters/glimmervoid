import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RELATIVE_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

function relativeImportsOf(source: string, fromFile: string): string[] {
  return [...source.matchAll(RELATIVE_IMPORT)].flatMap((match) => (match[1] ? [path.resolve(path.dirname(fromFile), match[1])] : []));
}

function codeStampOf(entryPath: string): string | null {
  const entryDirectory = path.dirname(path.resolve(entryPath));
  const hash = createHash('sha256');
  const visited = new Set<string>();
  const pending = [path.resolve(entryPath)];
  try {
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (visited.has(file)) continue;
      visited.add(file);
      const source = fs.readFileSync(file, 'utf8');
      hash.update(`${path.relative(entryDirectory, file)}\0${source}\0`);
      pending.push(...relativeImportsOf(source, file));
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

export { codeStampOf };
