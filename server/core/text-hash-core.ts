import crypto from 'node:crypto';

function hashText(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

export { hashText };
