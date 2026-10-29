const SANE_YOLO_PATH_ENV = 'GLIMMERVOID_SANE_YOLO_PATH';
const KIMI_SANE_YOLO_FLAVOR = 'kimi';
const CODEX_SANE_YOLO_FLAVOR = 'codex';
const SANE_YOLO_HOST_FLAGS: Record<string, string> = { [KIMI_SANE_YOLO_FLAVOR]: '--kimi-code', [CODEX_SANE_YOLO_FLAVOR]: '--codex' };

function saneYoloHostFlag(agentFlavor: string): string {
  return SANE_YOLO_HOST_FLAGS[agentFlavor] ?? '--grok-build';
}

function saneYoloPolicy(guardrailsTempRoot: string, unreadablePaths: readonly string[]) {
  return {
    version: 1,
    destructive_command_protection: {
      enabled: true,
      overrides: {
        'git.branch-force-delete': 'off',
        'git.merge-abort': 'off',
        'git.rebase-abort': 'off',
        'rm.recursive-force-dynamic-target': 'on',
      },
      allow_paths: [guardrailsTempRoot],
    },
    secret_protection: { enabled: true, deny_paths: [...unreadablePaths] },
  };
}

const SANE_YOLO_RULES = { version: 1, rules: ['infra'], overrides: {}, transparent_wrappers: ['rtk', 'npx'] };
const INFRA_REASON = 'Sane YOLO blocks infrastructure teardown; run this command by hand.';
const TERRAFORM_DESTROY_FLAGS = ['-destroy', '--destroy', '-destroy=true', '--destroy=true'];
const SANE_YOLO_INFRA_RULEBOOK = {
  rulebook_version: 1,
  name: 'infra',
  version: '1.1.0',
  allowed_commands: ['terraform', 'tofu', 'pulumi', 'kubectl'],
  rules: [
    { name: 'terraform-destroy', command: 'terraform', subcommand: 'destroy', block_args: ['destroy'], reason: INFRA_REASON },
    { name: 'terraform-apply-destroy', command: 'terraform', subcommand: 'apply', block_args: TERRAFORM_DESTROY_FLAGS, reason: INFRA_REASON },
    { name: 'tofu-destroy', command: 'tofu', subcommand: 'destroy', block_args: ['destroy'], reason: INFRA_REASON },
    { name: 'tofu-apply-destroy', command: 'tofu', subcommand: 'apply', block_args: TERRAFORM_DESTROY_FLAGS, reason: INFRA_REASON },
    { name: 'pulumi-destroy', command: 'pulumi', subcommand: 'destroy', block_args: ['destroy'], reason: INFRA_REASON },
    { name: 'pulumi-down', command: 'pulumi', subcommand: 'down', block_args: ['down'], reason: INFRA_REASON },
    { name: 'kubectl-delete-namespace', command: 'kubectl', subcommand: 'delete', block_args: ['ns', 'namespace', 'namespaces'], reason: INFRA_REASON },
  ],
};

function saneYoloFiles(guardrailsTempRoot: string, unreadablePaths: readonly string[]) {
  return {
    'policy.json': saneYoloPolicy(guardrailsTempRoot, unreadablePaths),
    'rules/rule.json': SANE_YOLO_RULES,
    'rules/infra/rulebook.json': SANE_YOLO_INFRA_RULEBOOK,
  };
}

function saneYoloEnv(homeDir: string): Record<string, string> {
  return {
    CC_SAFETY_NET_HOME: homeDir,
    CC_SAFETY_NET_PROJECT_TIGHTEN_ONLY: '1',
    CC_SAFETY_NET_AUDIT_HOME: homeDir,
    CC_SAFETY_NET_AUDIT_SCOPE: 'blocked',
  };
}

export { CODEX_SANE_YOLO_FLAVOR, KIMI_SANE_YOLO_FLAVOR, SANE_YOLO_PATH_ENV, saneYoloEnv, saneYoloFiles, saneYoloHostFlag };
