export const INSTALL_COMMAND =
  'npx --allow-remote=root --allow-scripts=node-pty https://github.com/johncwaters/glimmervoid/releases/latest/download/glimmervoid.tgz';

export type InstallCommandSegment =
  | { kind: 'text'; text: string }
  | { kind: 'unbroken'; text: string }
  | { kind: 'break-opportunity' };

const URL_SCHEME_SEPARATOR = '://';

function splitUrlAfterPathSlashes(url: string): InstallCommandSegment[] {
  const schemeSeparatorIndex = url.indexOf(URL_SCHEME_SEPARATOR);
  const pathSearchStart = schemeSeparatorIndex === -1 ? 0 : schemeSeparatorIndex + URL_SCHEME_SEPARATOR.length;
  const segments: InstallCommandSegment[] = [];
  let pieceStart = 0;
  let slashIndex = url.indexOf('/', pathSearchStart);
  while (slashIndex !== -1 && slashIndex < url.length - 1) {
    segments.push({ kind: 'text', text: url.slice(pieceStart, slashIndex + 1) }, { kind: 'break-opportunity' });
    pieceStart = slashIndex + 1;
    slashIndex = url.indexOf('/', pieceStart);
  }
  segments.push({ kind: 'text', text: url.slice(pieceStart) });
  return segments;
}

function segmentWord(word: string): InstallCommandSegment[] {
  if (word.includes(URL_SCHEME_SEPARATOR)) return splitUrlAfterPathSlashes(word);
  if (word.includes('-')) return [{ kind: 'unbroken', text: word }];
  return [{ kind: 'text', text: word }];
}

export function segmentInstallCommand(command: string): InstallCommandSegment[] {
  return command.split(' ').flatMap((word, wordIndex) => {
    const wordSegments = segmentWord(word);
    if (wordIndex === 0) return wordSegments;
    return [{ kind: 'text', text: ' ' } satisfies InstallCommandSegment, ...wordSegments];
  });
}
