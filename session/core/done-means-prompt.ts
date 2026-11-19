export function promptWithDoneMeans(prompt: string | null, doneMeans: readonly string[]): string | null {
  if (prompt === null || doneMeans.length === 0) return prompt;
  return `${prompt}\n\nDone means:\n${doneMeans.map((line) => `- ${line}`).join('\n')}`;
}
