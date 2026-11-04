import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function installFakeCoherence(worktree: string, { version = '1.8.0', hooksExitCode = 0, journal = '{}', journalDelayMs = 0 }: {
  version?: string; hooksExitCode?: number; journal?: string; journalDelayMs?: number;
} = {}): Promise<void> {
  const packageDirectory = path.join(worktree, 'node_modules', '@posthog', 'coherence');
  await mkdir(path.join(packageDirectory, 'dist'), { recursive: true });
  await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({ name: '@posthog/coherence', version, bin: { coherence: 'dist/cli.js' } }));
  await writeFile(path.join(worktree, 'coherence.config.json'), '{}');
  await writeFile(path.join(worktree, 'coherence-fixture.json'), JSON.stringify({ version, hooksExitCode, journal, journalDelayMs, root: worktree }));
  await writeFile(path.join(packageDirectory, 'dist', 'cli.js'), [
    "const fs = require('node:fs');",
    "const response = JSON.parse(fs.readFileSync('coherence-fixture.json', 'utf8'));",
    "const args = process.argv.slice(2);",
    "fs.appendFileSync('coherence-calls.jsonl', JSON.stringify({ args, env: process.env }) + '\\n');",
    "if (process.env.COHERENCE_NO_UPDATE_CHECK !== '1') process.exit(90);",
    "if (response.version === 'timeout') { setInterval(() => {}, 1000); return; }",
    "if (response.version === 'failure') process.exit(2);",
    "if (args[0] === 'version') { console.log('coherence ' + response.version + ': the installed package (node_modules).'); process.exit(0); }",
    "if (args[0] === 'hooks') process.exit(response.hooksExitCode);",
    "const answerJournal = () => { fs.mkdirSync(require('node:path').join(response.root, '.coherence', 'structure'), { recursive: true }); process.stdout.write(response.journal); process.exit(0); };",
    "if (args[0] === 'journal' && response.journalDelayMs > 0) { setTimeout(answerJournal, response.journalDelayMs); return; }",
    "if (args[0] === 'journal') { process.stdout.write(response.journal); process.exit(0); }",
    'process.exit(91);',
  ].join('\n'));
}
