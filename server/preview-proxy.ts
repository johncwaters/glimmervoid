import type { IncomingMessage } from 'node:http';
import type { Express, NextFunction, Request, Response } from 'express';
import { createProxyServer } from 'httpxy';
import { OPERATOR_HEADERS_DROPPED, isPreviewRequestPath, previewRefusal, previewSessionIdOf, previewUpstreamHeaders } from './core/preview-proxy-core.ts';
import { errorMessage } from '../shared/text.ts';

interface PreviewProxyDependencies {
  previewPortOf: (sessionId: string) => number | null;
  glimmervoidPortsFor: (request: IncomingMessage) => number[];
  logger: Pick<Console, 'warn'>;
}

export function mountPreviewProxy(app: Express, { previewPortOf, glimmervoidPortsFor, logger }: PreviewProxyDependencies): void {
  const proxy = createProxyServer({ xfwd: false, changeOrigin: true });
  proxy.on('proxyRes', (upstreamResponse, request) => {
    upstreamResponse.headers = previewUpstreamHeaders(upstreamResponse.headers, request.headers.origin);
  });
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (!isPreviewRequestPath(request.url ?? '')) {
      next();
      return;
    }
    const sessionId = previewSessionIdOf(request.url ?? '');
    const port = sessionId === null ? null : previewPortOf(sessionId);
    const refusal = previewRefusal(port, glimmervoidPortsFor(request));
    if (refusal !== null || port === null) {
      response.status(404).type('text/plain').send(refusal ?? 'no preview');
      return;
    }
    for (const header of OPERATOR_HEADERS_DROPPED) delete request.headers[header];
    proxy.web(request, response, { target: `http://127.0.0.1:${port}` }).catch((forwardError: unknown) => {
      logger.warn(`[preview] ${sessionId} on port ${port}: ${errorMessage(forwardError)}`);
      if (!response.headersSent) response.status(502).type('text/plain').send(`nothing answered on port ${port}; is the dev server running?`);
    });
  });
}
