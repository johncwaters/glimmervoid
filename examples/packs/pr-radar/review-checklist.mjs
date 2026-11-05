const [pullRequestUrl, headRef, baseRef] = process.argv.slice(2);

const checklist = [
  `Review checklist for ${pullRequestUrl}`,
  `Branch ${headRef} into ${baseRef}`,
  '- Does the description say why, not only what?',
  '- Is every new behavior covered by a test that failed before the change?',
  '- Is the CHANGELOG updated for anything the operator sees?',
];

process.stdout.write(`${checklist.join('\n')}\n`);
