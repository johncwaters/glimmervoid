type PermissionFields = { dangerouslySkipPermissions: true; saneYolo: true } | Record<string, never>;
type PermissionChoice = { fields: PermissionFields; isUnprotectedHintShown: boolean };

export function decidePermissions(input: { isSaneYoloInstalled: boolean; isSaneYoloSettingOn: boolean; isShell: boolean }): PermissionChoice {
  if (input.isShell) return { fields: {}, isUnprotectedHintShown: false };
  const canProtect = input.isSaneYoloInstalled && input.isSaneYoloSettingOn;
  if (!canProtect) return { fields: {}, isUnprotectedHintShown: true };
  return { fields: { dangerouslySkipPermissions: true, saneYolo: true }, isUnprotectedHintShown: false };
}
