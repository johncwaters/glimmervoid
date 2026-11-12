import type { BoardGraphicsResetProperties } from '#shared/contracts/control/control-fields.ts';

type BoardGraphicsEventKind = BoardGraphicsResetProperties['reset'];

interface BoardGraphicsEvent {
  kind: BoardGraphicsEventKind;
  lossCount: number;
  msSinceLastLoss: number | null;
  blankMs: number | null;
  retries: number;
  creationError: string | null;
  mediaTextureCount: number;
  mediaTextureBytes: number;
  canvasWidthPx: number;
  canvasHeightPx: number;
  devicePixelRatio: number;
  isPageVisible: boolean;
  gpuRenderer: string | null;
}

interface PageGraphicsFacts {
  boardId: string | null;
  terminalWebglContexts: number;
  sameOriginDashboardTabs: number | null;
}

const BYTES_PER_MIB = 1024 * 1024;
const GPU_RENDERER_MAX_CHARS = 200;
const CREATION_ERROR_MAX_CHARS = 300;

function mebibytesOf(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MIB) * 10) / 10;
}

function wholeMs(milliseconds: number | null): number | null {
  return milliseconds === null ? null : Math.max(0, Math.round(milliseconds));
}

function boardGraphicsTelemetryProperties(event: BoardGraphicsEvent, page: PageGraphicsFacts): BoardGraphicsResetProperties {
  return {
    reset: event.kind,
    loss_count: event.lossCount,
    ms_since_last_loss: wholeMs(event.msSinceLastLoss),
    blank_ms: wholeMs(event.blankMs),
    retries: event.retries,
    creation_error: event.creationError?.slice(0, CREATION_ERROR_MAX_CHARS) ?? null,
    terminal_webgl_contexts: page.terminalWebglContexts,
    same_origin_dashboard_tabs: page.sameOriginDashboardTabs,
    media_texture_count: event.mediaTextureCount,
    media_texture_mib: mebibytesOf(event.mediaTextureBytes),
    canvas_width_px: Math.round(event.canvasWidthPx),
    canvas_height_px: Math.round(event.canvasHeightPx),
    device_pixel_ratio: event.devicePixelRatio,
    is_page_visible: event.isPageVisible,
    gpu_renderer: event.gpuRenderer?.slice(0, GPU_RENDERER_MAX_CHARS) ?? null,
  };
}

function boardGraphicsLogText(event: BoardGraphicsEvent, page: PageGraphicsFacts): string {
  const properties = boardGraphicsTelemetryProperties(event, page);
  const fields = [
    properties.reset,
    `board=${page.boardId ?? 'none'}`,
    `losses=${properties.loss_count}`,
    ...(properties.reset === 'lost' ? [`sinceLastLossMs=${properties.ms_since_last_loss ?? 'first'}`] : []),
    ...(properties.blank_ms === null ? [] : [`blankMs=${properties.blank_ms}`, `retries=${properties.retries}`]),
    `terminalContexts=${properties.terminal_webgl_contexts}`,
    `sameOriginTabs=${properties.same_origin_dashboard_tabs ?? 'unknown'}`,
    `media=${properties.media_texture_count}/${properties.media_texture_mib}MiB`,
    `canvas=${properties.canvas_width_px}x${properties.canvas_height_px}@${properties.device_pixel_ratio}`,
    properties.is_page_visible ? 'visible' : 'hidden',
    `gpu=${JSON.stringify(properties.gpu_renderer ?? 'unknown')}`,
    ...(properties.creation_error === null ? [] : [`creationError=${JSON.stringify(properties.creation_error)}`]),
  ];
  return fields.join(' ');
}

export { boardGraphicsLogText, boardGraphicsTelemetryProperties };
export type { BoardGraphicsEvent, BoardGraphicsEventKind };
