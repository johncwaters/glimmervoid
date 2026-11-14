import fs from 'node:fs';
import type http from 'node:http';
import type { Plugin } from 'vite';

const DEVICE_LOG_ENDPOINT = '/__device-log';
const DEVICE_LOG_CLIENT_PATH = '/__device-log/client.js';
const MAX_POST_BYTES = 512 * 1024;
const WATCHED_SELECTORS = ['.terminal-select-mirror', '.terminal-select-sheet', '.phone-key-more-sheet'];

interface DeviceLoggerConfig {
  endpoint: string;
  watchedSelector: string;
  flushIntervalMs: number;
  maxBatchLines: number;
  maxBatchBytes: number;
}

function installDeviceLogger(config: DeviceLoggerConfig) {
  type LogFields = Record<string, unknown>;
  const pendingLines: LogFields[] = [];
  let gestureStartedAtMs = performance.now();
  let touchMoveCount = 0;
  let touchMoveMaxDistancePx = 0;
  let touchStartX = 0;
  let touchStartY = 0;
  let droppedBatchCount = 0;

  const describe = (target: EventTarget | Node | null | undefined): string => {
    if (!target) return 'none';
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    if (!element) return target instanceof Node ? target.nodeName : 'window';
    const id = element.id ? `#${element.id}` : '';
    const classes = [...element.classList].map((name) => `.${name}`).join('');
    return `${element.tagName.toLowerCase()}${id}${classes}`;
  };

  const post = (body: string, isPageHiding: boolean) => {
    const isKeepaliveSafe = isPageHiding && body.length <= config.maxBatchBytes;
    fetch(config.endpoint, { method: 'POST', body, keepalive: isKeepaliveSafe, headers: { 'content-type': 'application/json' } })
      .then((response) => {
        if (!response.ok) droppedBatchCount++;
      })
      .catch(() => {
        droppedBatchCount++;
      });
  };

  const flush = (isPageHiding: boolean) => {
    if (droppedBatchCount > 0) {
      pendingLines.unshift({ kind: 'batches-dropped', count: droppedBatchCount, atMs: Date.now() });
      droppedBatchCount = 0;
    }
    let batch: LogFields[] = [];
    let batchBytes = 0;
    for (const line of pendingLines.splice(0)) {
      const lineBytes = JSON.stringify(line).length + 1;
      if (batch.length > 0 && batchBytes + lineBytes > config.maxBatchBytes) {
        post(JSON.stringify({ lines: batch }), isPageHiding);
        batch = [];
        batchBytes = 0;
      }
      batch.push(line);
      batchBytes += lineBytes;
    }
    if (batch.length > 0) post(JSON.stringify({ lines: batch }), isPageHiding);
  };

  const formatConsoleArgument = (argument: unknown): string => {
    if (typeof argument === 'string') return argument;
    if (argument instanceof Error || argument instanceof DOMException) return `${argument.name}: ${argument.message}${argument.stack ? ` ${argument.stack}` : ''}`;
    try {
      return JSON.stringify(argument) ?? String(argument);
    } catch {
      return String(argument);
    }
  };

  const record = (kind: string, fields: LogFields = {}) => {
    pendingLines.push({ kind, sinceGestureMs: Math.round(performance.now() - gestureStartedAtMs), atMs: Date.now(), ...fields });
    if (pendingLines.length >= config.maxBatchLines) flush(false);
  };

  const listen = (target: EventTarget, type: string, handler: (event: Event) => void) => {
    target.addEventListener(type, handler, { capture: true, passive: true });
  };

  const describeSelection = () => {
    const selection = document.getSelection();
    if (!selection) return { selection: 'none' };
    return {
      isCollapsed: selection.isCollapsed,
      anchor: describe(selection.anchorNode),
      text: String(selection).slice(0, 80),
      rangeCount: selection.rangeCount,
    };
  };

  listen(document, 'touchstart', (event) => {
    const touchEvent = event as TouchEvent;
    const touch = touchEvent.touches[0];
    gestureStartedAtMs = performance.now();
    touchMoveCount = 0;
    touchMoveMaxDistancePx = 0;
    touchStartX = touch?.clientX ?? 0;
    touchStartY = touch?.clientY ?? 0;
    record('touchstart', { target: describe(event.target), x: Math.round(touchStartX), y: Math.round(touchStartY), touches: touchEvent.touches.length, active: describe(document.activeElement) });
  });
  listen(document, 'touchmove', (event) => {
    const touch = (event as TouchEvent).touches[0];
    if (!touch) return;
    touchMoveCount++;
    touchMoveMaxDistancePx = Math.max(touchMoveMaxDistancePx, Math.hypot(touch.clientX - touchStartX, touch.clientY - touchStartY));
  });
  for (const type of ['touchend', 'touchcancel']) {
    listen(document, type, (event) => {
      record(type, { target: describe(event.target), moves: touchMoveCount, maxDistancePx: Math.round(touchMoveMaxDistancePx), defaultPrevented: event.defaultPrevented });
    });
  }
  for (const type of ['pointerdown', 'pointerup', 'pointercancel']) {
    listen(document, type, (event) => {
      const pointerEvent = event as PointerEvent;
      record(type, { target: describe(event.target), pointerType: pointerEvent.pointerType, x: Math.round(pointerEvent.clientX), y: Math.round(pointerEvent.clientY) });
    });
  }
  listen(document, 'selectionchange', () => record('selectionchange', { ...describeSelection(), active: describe(document.activeElement) }));
  listen(document, 'focusin', (event) => record('focusin', { target: describe(event.target) }));
  listen(document, 'focusout', (event) => record('focusout', { target: describe(event.target), relatedTarget: describe((event as FocusEvent).relatedTarget) }));
  for (const type of ['beforeinput', 'input']) {
    listen(document, type, (event) => {
      const inputEvent = event as InputEvent;
      record(type, { target: describe(event.target), inputType: inputEvent.inputType, data: inputEvent.data, isComposing: inputEvent.isComposing });
    });
  }
  for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) {
    listen(document, type, (event) => record(type, { target: describe(event.target), data: (event as CompositionEvent).data }));
  }
  for (const type of ['keydown', 'keyup']) {
    listen(document, type, (event) => {
      const keyboardEvent = event as KeyboardEvent;
      record(type, { target: describe(event.target), key: keyboardEvent.key, code: keyboardEvent.code, isComposing: keyboardEvent.isComposing });
    });
  }
  listen(document, 'contextmenu', (event) => record('contextmenu', { target: describe(event.target), defaultPrevented: event.defaultPrevented }));
  listen(document, 'visibilitychange', () => record('visibilitychange', { state: document.visibilityState }));
  listen(window, 'orientationchange', () => record('orientationchange', { width: window.innerWidth, height: window.innerHeight }));
  listen(window, 'resize', () => record('resize', { width: window.innerWidth, height: window.innerHeight }));
  const viewport = window.visualViewport;
  if (viewport) {
    listen(viewport, 'resize', () => record('viewport-resize', { height: Math.round(viewport.height), width: Math.round(viewport.width), offsetTop: Math.round(viewport.offsetTop) }));
    listen(viewport, 'scroll', () => record('viewport-scroll', { offsetTop: Math.round(viewport.offsetTop), pageTop: Math.round(viewport.pageTop) }));
  }
  listen(window, 'error', (event) => {
    const errorEvent = event as ErrorEvent;
    record('error', { message: errorEvent.message, source: `${errorEvent.filename}:${errorEvent.lineno}:${errorEvent.colno}` });
  });
  listen(window, 'unhandledrejection', (event) => record('unhandledrejection', { reason: String((event as PromiseRejectionEvent).reason) }));

  for (const level of ['debug', 'log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      record(`console-${level}`, { text: args.map(formatConsoleArgument).join(' ').slice(0, 2000) });
      original(...args);
    };
  }

  const reportWatchedNodes = (nodes: NodeList, change: string) => {
    for (const node of nodes) {
      if (!(node instanceof Element)) continue;
      const watched = node.matches(config.watchedSelector) ? node : node.querySelector(config.watchedSelector);
      if (watched) record(`element-${change}`, { element: describe(watched), active: describe(document.activeElement) });
    }
  };
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      reportWatchedNodes(mutation.addedNodes, 'added');
      reportWatchedNodes(mutation.removedNodes, 'removed');
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  listen(window, 'pagehide', () => flush(true));
  setInterval(() => flush(false), config.flushIntervalMs);
  record('page-loaded', { url: location.href, width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio });
}

function deviceLoggerClientScript(): string {
  const config: DeviceLoggerConfig = {
    endpoint: DEVICE_LOG_ENDPOINT,
    watchedSelector: WATCHED_SELECTORS.join(', '),
    flushIntervalMs: 1000,
    maxBatchLines: 200,
    maxBatchBytes: 48 * 1024,
  };
  return `(${installDeviceLogger.toString()})(${JSON.stringify(config)});\n`;
}

export function withoutIpv4MappedPrefix(address: string): string {
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

function readRequestBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    request.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_POST_BYTES) {
        reject(new Error(`device log post over ${MAX_POST_BYTES} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function parseLoggedLines(body: string): unknown[] {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null || !('lines' in parsed) || !Array.isArray(parsed.lines)) return [];
  return parsed.lines;
}

function isSameOriginPost(request: http.IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

export function deviceLogPlugin(logPath: string): Plugin {
  return {
    name: 'harness-device-log',
    transformIndexHtml() {
      return [{ tag: 'script', attrs: { src: DEVICE_LOG_CLIENT_PATH }, injectTo: 'head-prepend' }];
    },
    configureServer(server) {
      server.middlewares.use(DEVICE_LOG_CLIENT_PATH, (_request, response) => {
        response.setHeader('content-type', 'text/javascript; charset=utf-8');
        response.setHeader('cache-control', 'no-store');
        response.end(deviceLoggerClientScript());
      });
      server.middlewares.use(DEVICE_LOG_ENDPOINT, (request, response) => {
        if (request.method !== 'POST') {
          response.statusCode = 405;
          response.end();
          return;
        }
        if (!isSameOriginPost(request)) {
          response.statusCode = 403;
          response.end();
          return;
        }
        const peer = withoutIpv4MappedPrefix(request.socket.remoteAddress ?? '');
        const userAgent = request.headers['user-agent'] ?? '';
        readRequestBody(request)
          .then((body) => {
            const receivedAtMs = Date.now();
            const text = parseLoggedLines(body).map((line) => JSON.stringify({ ...(typeof line === 'object' && line !== null ? line : { value: line }), peer, userAgent, receivedAtMs })).join('\n');
            if (text === '') return undefined;
            return fs.promises.appendFile(logPath, `${text}\n`, 'utf8');
          })
          .then(() => {
            response.statusCode = 204;
            response.end();
          })
          .catch((error: unknown) => {
            console.error(`device log post from ${peer} failed: ${error instanceof Error ? error.message : String(error)}`);
            response.statusCode = 400;
            response.end();
          });
      });
    },
  };
}
