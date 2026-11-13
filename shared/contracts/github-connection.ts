import { z } from 'zod';
import { GithubLogin, GithubReconnectReason, MAX_BOUND_INSTALLATIONS } from './watcher-link.ts';

const PositiveInt = z.number().int().positive();
export const GithubRepositoryName = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);
export const MAX_BOUND_REPOSITORIES = 500;

export const GithubInstallationBinding = z.strictObject({
  installationId: PositiveInt,
  accountLogin: GithubLogin,
  repositories: z.array(GithubRepositoryName).min(1).max(MAX_BOUND_REPOSITORIES),
});
export type GithubInstallationBinding = z.infer<typeof GithubInstallationBinding>;

export const GithubUserRecord = z.strictObject({
  userId: PositiveInt,
  login: GithubLogin,
  refreshToken: z.string().min(1),
  refreshTokenExpiresAtMs: PositiveInt,
  installations: z.array(GithubInstallationBinding).max(MAX_BOUND_INSTALLATIONS),
  installationsReadAtMs: PositiveInt,
  reconnectReason: GithubReconnectReason.nullable(),
});
export type GithubUserRecord = z.infer<typeof GithubUserRecord>;

export const StoredGithubUser = z.strictObject({ record: GithubUserRecord.nullable() });
export type StoredGithubUser = z.infer<typeof StoredGithubUser>;
