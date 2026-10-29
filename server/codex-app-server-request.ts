import { spawn } from './child-process-safe.ts';

type CodexAppServerCommand = { file: string; argsBeforeAppServer: string[] };

interface CodexAppServerRequest {
  method: string;
  params: unknown;
  timeoutMs: number;
}

function requestCodexAppServer(command: CodexAppServerCommand, env: NodeJS.ProcessEnv, request: CodexAppServerRequest): Promise<{ result: unknown } | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.file, [...command.argsBeforeAppServer, 'app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let bufferedOutput = '';
    let isSettled = false;
    const settle = (response: { result: unknown } | null) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      child.kill();
      resolve(response);
    };
    const timer = setTimeout(() => settle(null), request.timeoutMs);
    const send = (message: unknown) => { child.stdin?.write(`${JSON.stringify(message)}\n`); };
    const handleLine = (line: string) => {
      let message: { id?: unknown; result?: unknown; error?: unknown };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error !== undefined) return settle(null);
        send({ jsonrpc: '2.0', method: 'initialized' });
        send({ jsonrpc: '2.0', id: 2, method: request.method, params: request.params });
        return;
      }
      if (message.id === 2) settle(message.error === undefined ? { result: message.result } : null);
    };
    child.on('error', () => settle(null));
    child.on('exit', () => settle(null));
    child.stdin?.on('error', () => settle(null));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      const lines = (bufferedOutput + chunk).split('\n');
      bufferedOutput = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'glimmervoid', title: null, version: '0.1.0' }, capabilities: null } });
  });
}

export { requestCodexAppServer };
export type { CodexAppServerCommand };
