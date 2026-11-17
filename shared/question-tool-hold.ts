export const QUESTION_TOOL_HOLD_HOOK_EVENT = 'pretooluse-question';
export const QUESTION_TOOL_HOLD_TIMEOUT_MS = 90_000;
export const CONVERSATION_PERMISSION_HOOK_EVENT = 'permissionrequest-conversation';
export const HELD_RELAY_HOOK_EVENTS: ReadonlySet<string> = new Set([QUESTION_TOOL_HOLD_HOOK_EVENT, CONVERSATION_PERMISSION_HOOK_EVENT]);
