import { el } from './dom-helpers.ts';

type SandboxedFrameSource = { kind: 'url'; url: string } | { kind: 'srcdoc'; html: string };

export function createSandboxedFrame({ source, className, title, allowsScripts }: {
  source: SandboxedFrameSource;
  className: string;
  title: string;
  allowsScripts: boolean;
}): HTMLIFrameElement {
  const frame = el('iframe', className);
  frame.setAttribute('sandbox', allowsScripts ? 'allow-scripts allow-forms' : '');
  frame.setAttribute('allow', '');
  frame.referrerPolicy = 'no-referrer';
  frame.title = title;
  if (source.kind === 'srcdoc') frame.srcdoc = source.html;
  if (source.kind === 'url') frame.src = source.url;
  return frame;
}
