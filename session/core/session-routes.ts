const SUPERVISION_LINE = "Glimmervoid supervises this session. Run glimmervoid --help for the commands it gives you and this session's limits.";
const SANDBOX_LINE = 'It runs in an OS-enforced sandbox, so a refused write or connection will not succeed on retry.';

function supervisionLine({ isSandboxed }: { isSandboxed: boolean }): string {
  if (!isSandboxed) return SUPERVISION_LINE;
  return `${SUPERVISION_LINE} ${SANDBOX_LINE}`;
}

export { supervisionLine };
