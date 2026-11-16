import { main } from '../mcp/stdio-bridge.ts';

if (process.argv[1] === import.meta.filename) {
  main().then((code) => process.exit(code)).catch(() => process.exit(0));
}

export { main };
