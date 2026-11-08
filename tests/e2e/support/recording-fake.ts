import http from 'node:http';
import { closeServer, listenOnLoopback } from '../../helpers/http-server.ts';

interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | null;
  body: string;
}

interface FakeAnswer {
  status: number;
  headers?: Readonly<Record<string, string>>;
  body: string;
}

type FakeHandler = (request: RecordedRequest) => FakeAnswer;

interface RecordingFake {
  origin: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function startRecordingFake(handler: FakeHandler): Promise<RecordingFake> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer(async (request, response) => {
    const recordedRequest: RecordedRequest = {
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      authorization: request.headers.authorization ?? null,
      body: await readBody(request),
    };
    requests.push(recordedRequest);
    const answer = handler(recordedRequest);
    response.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
    response.end(answer.body);
  });
  const port = await listenOnLoopback(server);
  return { origin: `http://127.0.0.1:${port}`, requests, close: () => closeServer(server) };
}

export { startRecordingFake };
export type { FakeAnswer, RecordedRequest, RecordingFake };
