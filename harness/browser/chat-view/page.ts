import type { TraceRecord } from '../../../shared/contracts/trace.ts';
import { appendChatRecords, createChatPartsState } from '../../../public/chat/chat-parts-core.ts';
import { createChatLog } from '../../../public/chat/chat-parts.ts';

const chatHost = document.getElementById('chat-host');
const traceResponse = await fetch('/trace-records.json');
const traceRecords: TraceRecord[] = await traceResponse.json();
const chatLog = createChatLog();
chatHost?.appendChild(chatLog.element);
chatLog.upsert(appendChatRecords(createChatPartsState(), traceRecords));
document.body.dataset.rendered = 'true';
