import type { SandboxRole } from '../../server/core/sandbox-policy-core.ts';
import type { WorkLaneDependencies } from '../../server/lanes/work-lane.ts';

function passthroughWorkLane(preparedRoles: SandboxRole[] = []): Pick<WorkLaneDependencies, 'prepareSandbox' | 'sandboxRefusal' | 'platform'> {
  return {
    platform: 'linux',
    sandboxRefusal: () => null,
    prepareSandbox: async ({ role }) => {
      preparedRoles.push(role);
      return { ok: true, launch: { wrap: async (file, args) => ({ file, args: [...args] }), env: {}, dispose: async () => {} } };
    },
  };
}

export { passthroughWorkLane };
