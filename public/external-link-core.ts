import { normalizedHttpUrl } from '#shared/http-url.ts';

const ELECTRON_USER_AGENT_TOKEN = /\bElectron\/\d/;
const LOOPBACK_PAGE_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

export function isHostedInEditorBrowser(userAgent: string): boolean {
  return ELECTRON_USER_AGENT_TOKEN.test(userAgent);
}

export function shouldOpenLinksOnHost({ userAgent, pageHostname }: { userAgent: string; pageHostname: string }): boolean {
  return isHostedInEditorBrowser(userAgent) && LOOPBACK_PAGE_HOSTNAMES.has(pageHostname);
}

export function isExternalHttpUrl(href: string): boolean {
  return normalizedHttpUrl(href) !== null;
}

const PRIMARY_AND_MIDDLE_BUTTONS: ReadonlySet<number> = new Set([0, 1]);

export function isNewTabActivation({ button, opensInNewTab }: { button: number; opensInNewTab: boolean }): boolean {
  return opensInNewTab && PRIMARY_AND_MIDDLE_BUTTONS.has(button);
}
