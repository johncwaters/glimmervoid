type MouseEncoding = 1006 | 1016 | null;

function updateMouseEncoding(
  encoding: MouseEncoding,
  params: readonly (number | readonly number[])[],
  isEnabled: boolean,
): MouseEncoding {
  let activeEncoding = encoding;
  for (const param of params) {
    const mode = typeof param === 'number' ? param : param[0];
    if (mode !== 1006 && mode !== 1016) continue;
    activeEncoding = isEnabled ? mode : null;
  }
  return activeEncoding;
}

function serializeMouseEncoding(encoding: MouseEncoding): string {
  if (encoding === null) return '';
  return `\x1b[?${encoding}h`;
}

export { updateMouseEncoding, serializeMouseEncoding };
export type { MouseEncoding };
