import type { TelegramDeliveryStatus } from '../../shared/contracts/control-messages.ts';

interface TelegramCredentials {
  botToken?: string | null;
  chatId?: string | null;
}

function blankTelegramFields({ botToken, chatId }: TelegramCredentials): string[] {
  const blankFields: string[] = [];
  if (!botToken?.trim()) blankFields.push('bot token');
  if (!chatId?.trim()) blankFields.push('chat id');
  return blankFields;
}

function describeBlankFields(blankFields: readonly string[]): string {
  return blankFields.length > 1 ? `${blankFields.join(' and ')} are` : `${blankFields[0]} is`;
}

export function telegramSetupWarning({ isEnabled, ...credentials }: TelegramCredentials & { isEnabled: boolean }): string | null {
  if (!isEnabled) return null;
  const blankFields = blankTelegramFields(credentials);
  if (blankFields.length === 0) return null;
  return `Session notifications are on, but the ${describeBlankFields(blankFields)} blank, so nothing is sent.`;
}

export function telegramTestRefusal(credentials: TelegramCredentials): string | null {
  const blankFields = blankTelegramFields(credentials);
  if (blankFields.length === 0) return null;
  return `The ${describeBlankFields(blankFields)} blank. Fill ${blankFields.length > 1 ? 'them' : 'it'} in first.`;
}

export interface TelegramDeliveryControl {
  status: () => TelegramDeliveryStatus;
  sendTest: () => Promise<{ ok: boolean; error: string | null }>;
}
