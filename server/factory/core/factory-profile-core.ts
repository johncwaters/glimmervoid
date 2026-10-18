import type { ProjectConfig } from '../../../shared/contracts/config.ts';

type FactoryProfile = NonNullable<ProjectConfig['factoryProfile']>;

export const DEFAULT_WIDENABLE_SCOPES = ['tests/', 'test/', '__tests__/', '**/*.test.*', '**/*.spec.*'];

export function resolveFactoryProfile(globalSettings: FactoryProfile | null | undefined, project?: Pick<ProjectConfig, 'factoryProfile'> | null) {
  const effectiveProfile = { ...globalSettings };
  for (const [field, value] of Object.entries(project?.factoryProfile ?? {})) {
    if (value === undefined) continue;
    Object.assign(effectiveProfile, { [field]: value });
  }
  return {
    ...effectiveProfile,
    widenableScopes: effectiveProfile.widenableScopes ?? [...DEFAULT_WIDENABLE_SCOPES],
  };
}
