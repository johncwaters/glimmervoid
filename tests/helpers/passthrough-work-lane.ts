import type { GuardrailsRole } from '../../server/guardrails/core/guardrails-policy-core.ts';
import type { WorkLaneDependencies } from '../../server/lanes/work-lane.ts';

function passthroughWorkLane(preparedRoles: GuardrailsRole[] = []): Pick<WorkLaneDependencies, 'prepareGuardrails' | 'guardrailsRefusal' | 'platform'> {
  return {
    platform: 'linux',
    guardrailsRefusal: () => null,
    prepareGuardrails: async ({ role }) => {
      preparedRoles.push(role);
      return { ok: true, launch: { wrap: async (file, args) => ({ file, args: [...args] }), env: {}, dispose: async () => {} } };
    },
  };
}

export { passthroughWorkLane };
