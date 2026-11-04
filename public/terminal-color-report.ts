import { sendControlMsg } from './control-ws.ts';
import { getTerminalTheme } from './theme.ts';

export function reportTerminalColors() {
  const terminalTheme = getTerminalTheme();
  if (!terminalTheme.background || !terminalTheme.foreground) return;
  sendControlMsg({ type: 'terminal-colors', background: terminalTheme.background, foreground: terminalTheme.foreground });
}
