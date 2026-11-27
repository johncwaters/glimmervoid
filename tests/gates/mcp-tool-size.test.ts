import '../helpers/isolate-home.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { GROUPED_TOOLS, inputSchemaFor } from '../../mcp/core/tools.ts';

const AGY_ACP_TOOL_DECLARATION_BUDGET_BYTES = 18_000;

test('every MCP tool declaration fits under the agy acp 19.7 KB size cap with headroom', () => {
  const oversizedTools: string[] = [];
  for (const tool of GROUPED_TOOLS) {
    const inputSchema = z.toJSONSchema(inputSchemaFor(tool, Object.keys(tool.actions)), { io: 'input' });
    const serializedDeclaration = JSON.stringify({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema,
    });
    const declarationBytes = Buffer.byteLength(serializedDeclaration, 'utf8');
    if (declarationBytes > AGY_ACP_TOOL_DECLARATION_BUDGET_BYTES) {
      oversizedTools.push(`${tool.name}: ${declarationBytes} bytes (limit ${AGY_ACP_TOOL_DECLARATION_BUDGET_BYTES})`);
    }
  }
  assert.deepEqual(
    oversizedTools,
    [],
    `MCP tool declarations exceed ${AGY_ACP_TOOL_DECLARATION_BUDGET_BYTES} bytes (agy acp drops eager tools past ~19.7 KB; see docs/acp-spike-2026-11.md): ${oversizedTools.join(', ')}`,
  );
});
