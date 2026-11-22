import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  ContractTerms,
  MessageChannel,
  OrderItem,
  SeatId,
  SignedReport,
  WARGAMES_NOTE_MAX_BYTES,
} from '../shared/contracts/wargames.ts';
import type { WargamesRejection } from '../shared/contracts/wargames.ts';

export const WARGAMES_TOOL_NAMES = [
  'get_state',
  'get_reports',
  'verify_report',
  'read_messages',
  'read_notes',
  'send_message',
  'propose_contract',
  'accept_contract',
  'submit_orders',
  'write_note',
] as const;

export type WargamesToolName = (typeof WARGAMES_TOOL_NAMES)[number];

export type WargamesToolReply =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; rejection: WargamesRejection };

export interface WargamesSeatBinding {
  matchId: string;
  seatId: SeatId;
}

export interface WargamesSeatPort {
  seatForSession(sessionId: string): WargamesSeatBinding | null;
  isWargamesSession(sessionId: string): boolean;
  callTool(
    matchId: string,
    seatId: SeatId,
    toolName: WargamesToolName,
    args: Record<string, unknown>,
  ): Promise<WargamesToolReply>;
}

const SERVER_NAME = 'glimmervoid-wargames';
const SERVER_VERSION = '1';

function formatToolReply(reply: WargamesToolReply) {
  if (reply.ok) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...reply.payload }) }],
    };
  }
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, rejection: reply.rejection }) }],
  };
}

export function buildWargamesSeatServer(
  matchId: string,
  seatId: SeatId,
  port: WargamesSeatPort,
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: `You are seat ${seatId} in Wargames match ${matchId}. Play exclusively through these 10 MCP tools. Opponent model names are hidden. Notes are capped at ${WARGAMES_NOTE_MAX_BYTES} bytes.`,
      capabilities: { tools: { listChanged: false } },
    },
  );

  server.registerTool('get_state', {
    title: 'Get Match State',
    description: 'Read your fog-of-war view of the current tick, phase, visible villages, armies, contracts, and breach ledger. Pass ready: true during talk or contracts when finished so the phase can advance early, and wait_for_change: true to block until the tick, phase, or match status changes.',
    inputSchema: z.strictObject({
      ready: z.boolean().optional(),
      wait_for_change: z.boolean().optional(),
    }),
  }, async (args) => formatToolReply(await port.callTool(matchId, seatId, 'get_state', args)));

  server.registerTool('get_reports', {
    title: 'Get Signed Reports',
    description: 'Read engine-signed battle and scout reports received since a given tick.',
    inputSchema: z.strictObject({ since_tick: z.number().int().min(0).default(0) }),
  }, async (args) => formatToolReply(await port.callTool(matchId, seatId, 'get_reports', args)));

  server.registerTool('verify_report', {
    title: 'Verify Signed Report',
    description: 'Check whether a battle or scout report carries a valid engine signature.',
    inputSchema: z.strictObject({ report: SignedReport }),
  }, async (args) => formatToolReply(await port.callTool(matchId, seatId, 'verify_report', args)));

  server.registerTool('read_messages', {
    title: 'Read Messages',
    description: 'Read DMs addressed to you or sent by you and your tribe channel messages since a given tick.',
    inputSchema: z.strictObject({ since_tick: z.number().int().min(0).default(0) }),
  }, async (args) => formatToolReply(await port.callTool(matchId, seatId, 'read_messages', args)));

  server.registerTool('read_notes', {
    title: 'Read Private Notes',
    description: 'Read your private scratchpad notes (4 KB max).',
    inputSchema: z.strictObject({}),
  }, async () => formatToolReply(await port.callTool(matchId, seatId, 'read_notes', {})));

  server.registerTool('send_message', {
    title: 'Send Message',
    description: 'Send a DM or tribe message during the talk phase (at most 2 messages per tick). Optionally attach a signed or modified report.',
    inputSchema: z.strictObject({
      channel: MessageChannel.default('dm'),
      to: SeatId.nullable().default(null),
      text: z.string().min(1).max(2000),
      attachedReport: SignedReport.nullable().default(null),
    }),
  }, async (args) => formatToolReply(await port.callTool(matchId, seatId, 'send_message', args)));

  server.registerTool('propose_contract', {
    title: 'Propose Contract',
    description: 'Propose an engine-enforced escrow or collateral-backed NAP contract during the contracts phase.',
    inputSchema: z.strictObject({ terms: ContractTerms }),
  }, async (args) => formatToolReply(await port.callTool(matchId, seatId, 'propose_contract', args)));

  server.registerTool('accept_contract', {
    title: 'Accept Contract',
    description: 'Accept a pending contract proposed to you during the contracts phase.',
    inputSchema: z.strictObject({ id: z.string().min(1).max(64) }),
  }, async (args) => formatToolReply(await port.callTool(matchId, seatId, 'accept_contract', args)));

  server.registerTool('submit_orders', {
    title: 'Submit Sealed Orders',
    description: 'Seal your orders (build, train, march, scout, tribe_join, tribe_leave) for simultaneous resolution during the orders phase.',
    inputSchema: z.strictObject({ orders: z.array(OrderItem).max(64) }),
  }, async (args) => formatToolReply(await port.callTool(matchId, seatId, 'submit_orders', args)));

  server.registerTool('write_note', {
    title: 'Write Private Notes',
    description: `Overwrite your private scratchpad notes (max ${WARGAMES_NOTE_MAX_BYTES} UTF-8 bytes).`,
    inputSchema: z.strictObject({ text: z.string().max(WARGAMES_NOTE_MAX_BYTES) }),
  }, async (args) => formatToolReply(await port.callTool(matchId, seatId, 'write_note', args)));

  return server;
}
