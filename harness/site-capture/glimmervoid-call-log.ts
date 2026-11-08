import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { z } from 'zod';

const mcpHookFlag = '--mcp-hook';
const glimmervoidToolPrefix = 'mcp__glimmervoid__';
const McpToolUse = z.object({ tool_name: z.string(), tool_input: z.record(z.string(), z.unknown()), cwd: z.string() });

function worktreeRelativePath(requestedPath: unknown, cwd: string): string | null {
  if (typeof requestedPath !== 'string') return null;
  const relativePath = path.relative(cwd, path.resolve(cwd, requestedPath));
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;
  return relativePath;
}

async function logMcpToolUse(callLogPath: string): Promise<void> {
  const toolUse = McpToolUse.parse(JSON.parse(await text(process.stdin)));
  if (!toolUse.tool_name.startsWith(glimmervoidToolPrefix)) return;
  const tool = toolUse.tool_name.slice(glimmervoidToolPrefix.length);
  const relativePath = worktreeRelativePath(toolUse.tool_input.path, toolUse.cwd);
  const contents = relativePath === null ? null : await fs.readFile(path.join(toolUse.cwd, relativePath)).catch(() => null);
  const input = relativePath === null ? toolUse.tool_input : { ...toolUse.tool_input, path: relativePath };
  const filesByRelativePath = relativePath !== null && contents ? { [relativePath]: contents.toString('base64') } : {};
  await fs.appendFile(callLogPath, `${JSON.stringify({ ts: Date.now(), tool, input, filesByRelativePath })}\n`);
}

async function runLoggedCli(callLogPath: string, glimmervoidCliPath: string, glimmervoidArguments: string[]): Promise<void> {
  const calledAt = Date.now();
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [glimmervoidCliPath, ...glimmervoidArguments], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  await fs.appendFile(callLogPath, `${JSON.stringify({ ts: calledAt, args: glimmervoidArguments, exitCode })}\n`);
  process.exitCode = exitCode;
}

const [firstArgument, secondArgument, ...remainingArguments] = process.argv.slice(2);
if (!firstArgument || !secondArgument) throw new Error('usage: glimmervoid-call-log.ts <call-log> <glimmervoid-cli> [args...] | --mcp-hook <call-log>');
const isMcpHook = firstArgument === mcpHookFlag;
if (isMcpHook) await logMcpToolUse(secondArgument);
if (!isMcpHook) await runLoggedCli(firstArgument, secondArgument, remainingArguments);
