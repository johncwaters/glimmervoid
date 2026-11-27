import type { InstallFailureKind, NoticeId, NoticeTone } from '#shared/contracts/control-messages.ts';

export type NoticeReported = {
  source: string;
  kind?: InstallFailureKind;
};

export type NoticeShownPayload = {
  notice: NoticeId;
  message: string;
  tone?: NoticeTone;
  source?: string;
  kind?: InstallFailureKind;
};

type NoticeMetaState = {
  text: string;
  hidden: boolean;
};

type NoticeDescriptorInput = {
  id: NoticeId;
  dismissLabel: string;
  isDismissIcon: boolean;
  shown: boolean;
  tone?: NoticeTone;
  hasActions: boolean;
  command?: string;
  meta?: string;
};

type NoticeDescriptor = {
  className: 'notice';
  textClassName: 'notice-text';
  actionsClassName: 'notice-actions';
  commandClassName: 'notice-command';
  metaClassName: 'notice-meta';
  dismissClassName: 'notice-dismiss';
  dismissAction: 'dismiss-notice';
  copyAction: 'copy-notice-command';
  role: 'status';
  id: NoticeId;
  shown: boolean;
  hidden: boolean;
  tone?: NoticeTone;
  command: string;
  actionsHidden: boolean;
  commandHidden: boolean;
  meta: string;
  metaHidden: boolean;
  dismissVariant: 'icon' | 'secondary';
  dismissLabel: string;
};

export function noticeMetaState(metaText: string): NoticeMetaState {
  return { text: metaText, hidden: metaText === '' };
}

export function noticeShownPayload(input: {
  id: NoticeId;
  message: string;
  tone?: NoticeTone;
  reported?: NoticeReported;
}): NoticeShownPayload {
  return {
    notice: input.id,
    message: input.message,
    ...(input.tone ? { tone: input.tone } : {}),
    ...input.reported,
  };
}

export function noticeDescriptor(input: NoticeDescriptorInput): NoticeDescriptor {
  const command = input.command ?? '';
  const meta = input.meta ?? '';
  const hasCommand = command !== '';
  return {
    className: 'notice',
    textClassName: 'notice-text',
    actionsClassName: 'notice-actions',
    commandClassName: 'notice-command',
    metaClassName: 'notice-meta',
    dismissClassName: 'notice-dismiss',
    dismissAction: 'dismiss-notice',
    copyAction: 'copy-notice-command',
    role: 'status',
    id: input.id,
    shown: input.shown,
    hidden: !input.shown,
    tone: input.tone,
    command,
    actionsHidden: input.shown ? !input.hasActions : false,
    commandHidden: input.shown ? !hasCommand : false,
    meta,
    metaHidden: input.shown ? meta === '' : false,
    dismissVariant: input.isDismissIcon ? 'icon' : 'secondary',
    dismissLabel: input.dismissLabel,
  };
}
