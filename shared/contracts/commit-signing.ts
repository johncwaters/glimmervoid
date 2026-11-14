import { z } from 'zod';
import { GithubLogin } from './watcher-link.ts';

const GithubKeyId = z.number().int().positive();

export const GitIdentity = z.strictObject({ name: z.string().min(1), email: z.string().min(1) });
export type GitIdentity = z.infer<typeof GitIdentity>;

export const CommitSigningRecord = z.strictObject({
  github: z.strictObject({ login: GithubLogin, keyId: GithubKeyId }).nullable(),
  identity: GitIdentity.nullable().default(null),
  isSwitchedOff: z.boolean().default(false),
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
  identity: GitIdentity.nullable(),
});
export type CommitSigningStatus = z.infer<typeof CommitSigningStatus>;

export const GithubSigningKeyCreated = z.object({ id: GithubKeyId, key: z.string() });
export const GithubSigningKeyList = z.array(GithubSigningKeyCreated);
export const GithubUser = z.object({ id: z.number().int().positive(), login: GithubLogin, name: z.string().nullable() });
export type GithubUser = z.infer<typeof GithubUser>;
