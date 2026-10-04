import { sendControlMsg } from './control-ws.ts';
import { sessionName, sessionUIs } from './session-card/card-registry.ts';
import { openConfirmDialog } from './session-card/modal.ts';
import { suggestSessionName } from './session-card/naming.ts';

export function quickAddSession(path: string | null | undefined, label: string | null | undefined) {
  if (!path) return;
  sendControlMsg({ type: 'add-session', name: suggestSessionName(label), path });
}

export function requestSessionRemoval(id: string, mergeStatus?: string) {
  const ui = sessionUIs.get(id);
  if (!ui) return;
  const currentMergeStatus = mergeStatus || ui.card?.dataset.merge || 'none';
  const hasUnmergedWork = currentMergeStatus === 'pending-review' || currentMergeStatus === 'parked';
  if (!hasUnmergedWork) {
    sendControlMsg({ type: 'remove-session', id });
    return;
  }
  openConfirmDialog({
    title: 'Remove Session',
    message: `"${sessionName(ui)}" has unmerged worktree changes that will be permanently discarded if you remove it. Merge or review them first to keep them. Remove anyway?`,
    confirmLabel: 'Discard & Remove',
    onConfirm: () => sendControlMsg({ type: 'remove-session', id }),
  });
}
