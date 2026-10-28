import { describeFailure } from '../client-error-core.ts';
import { reportToServerLog } from '../control-ws.ts';

type PhoneShellModule = typeof import('./phone-shell.ts');
type PhoneShellHooks = Parameters<PhoneShellModule['mountPhoneShell']>[0];
type PhoneActivation = Parameters<PhoneShellModule['activatePhoneShell']>[0];

let loadedShell: PhoneShellModule | null = null;
let pendingShellLoad: Promise<PhoneShellModule | null> | null = null;
let mountHooks: PhoneShellHooks = {};
let wantedActivation: { options: PhoneActivation } | null = null;
let pendingNavigation: ((shell: PhoneShellModule) => void) | null = null;
let latestPanelOrder: readonly string[] | null = null;
const availabilityByScreenId = new Map<string, boolean>();
const attentionByScreenId = new Map<string, string | boolean | null>();

function loadPhoneShell(): Promise<PhoneShellModule | null> {
  pendingShellLoad ??= import('./phone-shell.ts').then(
    (shell) => {
      shell.mountPhoneShell(mountHooks);
      if (latestPanelOrder) shell.orderPhonePanels(latestPanelOrder);
      for (const [screenId, isAvailable] of availabilityByScreenId) shell.setPhoneScreenAvailable(screenId, isAvailable);
      for (const [screenId, attention] of attentionByScreenId) shell.setPhoneScreenAttention(screenId, attention);
      loadedShell = shell;
      return shell;
    },
    (error: unknown) => {
      pendingShellLoad = null;
      reportToServerLog('phone-shell', `phone shell failed to load: ${describeFailure(error)}`);
      return null;
    },
  );
  return pendingShellLoad;
}

export function mountPhoneShell(hooks: PhoneShellHooks): void {
  mountHooks = hooks;
}

export async function activatePhoneShell(options: PhoneActivation): Promise<boolean> {
  const activation = { options };
  wantedActivation = activation;
  const shell = await loadPhoneShell();
  if (wantedActivation !== activation) return false;
  if (!shell) {
    wantedActivation = null;
    pendingNavigation = null;
    return false;
  }
  wantedActivation = null;
  shell.activatePhoneShell(activation.options);
  const navigation = pendingNavigation;
  pendingNavigation = null;
  navigation?.(shell);
  return true;
}

export function deactivatePhoneShell(): void {
  wantedActivation = null;
  pendingNavigation = null;
  loadedShell?.deactivatePhoneShell();
}

export function isPhoneShellActive(): boolean {
  return wantedActivation !== null || (loadedShell?.isPhoneShellActive() ?? false);
}

export function getPhoneSessionId(): string | null {
  if (wantedActivation) return wantedActivation.options?.sessionId ?? null;
  return loadedShell?.getPhoneSessionId() ?? null;
}

export function orderPhonePanels(orderedViewIds: readonly string[]): void {
  latestPanelOrder = orderedViewIds;
  loadedShell?.orderPhonePanels(orderedViewIds);
}

export function setPhoneScreenAvailable(screenId: string, isAvailable: boolean): void {
  availabilityByScreenId.set(screenId, isAvailable);
  loadedShell?.setPhoneScreenAvailable(screenId, isAvailable);
}

export function setPhoneScreenAttention(screenId: string, attention: string | boolean | null): void {
  attentionByScreenId.set(screenId, attention);
  loadedShell?.setPhoneScreenAttention(screenId, attention);
}

export function refreshPhoneBoard(): void {
  loadedShell?.refreshPhoneBoard();
}

export function syncPhoneHistory(): void {
  loadedShell?.syncPhoneHistory();
}

function navigateOnceActive(navigate: (shell: PhoneShellModule) => boolean): boolean {
  if (!wantedActivation) return loadedShell ? navigate(loadedShell) : false;
  pendingNavigation = (shell) => { navigate(shell); };
  return true;
}

export function showPhonePlan(sessionId: string): boolean {
  return navigateOnceActive((shell) => shell.showPhonePlan(sessionId));
}

export function showPhoneSession(sessionId: string): boolean {
  return navigateOnceActive((shell) => shell.showPhoneSession(sessionId));
}

export function showPhoneScreen(screenId: string): boolean {
  return navigateOnceActive((shell) => shell.showPhoneScreen(screenId));
}
