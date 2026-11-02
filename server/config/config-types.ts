import type { readEnvSecrets } from '../core/config-secrets-core.ts';
import type { Config } from '../../shared/contracts/index.ts';

type ProjectEntry = Config['projects'][number] & { id: string; name: string };
interface GlimmervoidConfig extends Config {
  projects: ProjectEntry[];
}
type ConfigValidation = { ok: true; config: GlimmervoidConfig } | { ok: false; errors: string[] };
type ConfigFileSave = { ok: true; config: GlimmervoidConfig } | { ok: false; message: string };
type EnvSecrets = ReturnType<typeof readEnvSecrets>;

export type { ProjectEntry, GlimmervoidConfig, ConfigValidation, ConfigFileSave, EnvSecrets };
