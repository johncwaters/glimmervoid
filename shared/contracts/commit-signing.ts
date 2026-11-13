import { z } from 'zod';
import { GithubLogin } from './watcher-link.ts';

const GithubKeyId = z.number().int().positive();

export const CommitSigningRecord = z.strictObject({
  github: z.strictObject({ login: GithubLogin, keyId: GithubKeyId }).nullable(),
});
export type CommitSigningRecord = z.infer<typeof CommitSigningRecord>;

export const CommitSigningAction = z.enum(['read', 'setup', 'register', 'remove']);
export type CommitSigningAction = z.infer<typeof CommitSigningAction>;

export const CommitSigningStatus = z.strictObject({
  state: z.enum(['off', 'unregistered', 'registered']),
  fingerprint: z.string().nullable(),
  publicKey: z.string().nullable(),
  login: GithubLogin.nullable(),
  canRegister: z.boolean(),
  problem: z.string().nullable(),
});
export type CommitSigningStatus = z.infer<typeof CommitSigningStatus>;

export const GithubSigningKeyCreated = z.object({ id: GithubKeyId, key: z.string() });
export const GithubSigningKeyList = z.array(GithubSigningKeyCreated);
