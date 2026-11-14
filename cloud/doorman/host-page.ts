import crypto from 'node:crypto';
import { BRAND_MARK_BRACKETS, BRAND_MARK_LIGHT, BRAND_MARK_VIEWBOX } from '../../shared/brand-mark.ts';
import type { WakePageState } from './doorman-core.ts';

const TYPICAL_WAKE_SECONDS = 15;
const WAKE_POLL_MS = 1000;
const WAKE_POLL_HEADER = 'x-glimmervoid-wake-poll';

const HOST_PAGE_STYLES = [
  ':root{--bg:#0f0d15;--border-dim:#2b2636;--text:#cfcbd9;--text-head:#efedf6;--text-muted:#9e97af;--accent:#b688fe;--state-failed:#f84d4c}',
  "html,body{margin:0;background:var(--bg);color:var(--text);font-family:'CommitMono','Cascadia Code','Fira Code','Consolas','Menlo',monospace}",
  'body{display:flex;min-height:100vh;align-items:center;justify-content:center}',
  'main{display:flex;flex-direction:column;align-items:center;gap:12px;max-width:44ch;padding:24px;text-align:center}',
  '.mark{width:72px;height:72px;margin-bottom:8px;overflow:visible}',
  '.bracket{fill:none;stroke:var(--text-head);stroke-width:11;stroke-linejoin:miter;stroke-linecap:butt}',
  '.bracket[data-side="top"]{--dx:0;--dy:1}',
  '.bracket[data-side="right"]{--dx:-1;--dy:0;animation-delay:325ms}',
  '.bracket[data-side="bottom"]{--dx:0;--dy:-1;animation-delay:650ms}',
  '.bracket[data-side="left"]{--dx:1;--dy:0;animation-delay:975ms}',
  '.light{fill:var(--state-failed);opacity:0}',
  '[data-light="failed"] .light{opacity:1}',
  'h1{margin:0;font-size:16px;line-height:1.3;font-weight:700;color:var(--text-head)}',
  'p{margin:0;font-size:14px;line-height:1.5;text-wrap:balance}',
  '.meta{font-size:12px;line-height:1.55;color:var(--text-muted)}',
  '.bar{width:min(240px,100%);height:4px;border-radius:2px;background:var(--border-dim);overflow:hidden}',
  '.bar-fill{height:100%;background:var(--accent);transform-origin:left;transform:scaleX(var(--fraction,0))}',
  '[data-phase="holding"] .bar,[data-phase="holding"] #wake-elapsed{visibility:hidden}',
  '@media (prefers-reduced-motion:no-preference){[data-phase="waking"] .bracket{animation:mark-scan 1.3s cubic-bezier(0.2,0.8,0.2,1) infinite}.bar-fill{transition:transform 1s linear}}',
  '@keyframes mark-scan{0%,30%,100%{transform:none;stroke:var(--text-head)}12%{transform:translate(calc(var(--dx)*6px),calc(var(--dy)*6px));stroke:var(--accent)}}',
].join('');

const HOST_PAGE_SCRIPT = `(() => {
  const paintSavedThemeColors = () => {
    let savedPrefs;
    try { savedPrefs = JSON.parse(localStorage.getItem('glimmervoid-ui-prefs') || '{}'); } catch { return; }
    const themeColors = savedPrefs && savedPrefs.themeColors;
    if (!themeColors || typeof themeColors !== 'object') return;
    for (const propertyName of Object.keys(themeColors)) {
      if (propertyName.startsWith('--') && typeof themeColors[propertyName] === 'string') document.documentElement.style.setProperty(propertyName, themeColors[propertyName]);
    }
  };
  paintSavedThemeColors();
  const wake = document.getElementById('wake');
  if (wake === null) return;
  const unreachableLine = document.getElementById('wake-unreachable');
  const slotIds = ['wake-status', 'wake-elapsed'];
  const showRender = (render) => {
    wake.dataset.phase = render.dataset.phase;
    wake.dataset.light = render.dataset.light;
    wake.style.setProperty('--fraction', render.dataset.fraction);
    for (const slotId of slotIds) {
      const slot = document.getElementById(slotId);
      const renderedText = render.querySelector('#' + slotId).textContent;
      if (slot.textContent !== renderedText) slot.textContent = renderedText;
    }
  };
  const readRender = async () => {
    const response = await fetch(location.href, { headers: { accept: 'text/html', '${WAKE_POLL_HEADER}': '1' }, cache: 'no-store', redirect: 'manual' });
    if (response.status !== 503) return null;
    return new DOMParser().parseFromString(await response.text(), 'text/html').getElementById('wake');
  };
  const poll = async () => {
    let render;
    try {
      render = await readRender();
    } catch {
      unreachableLine.hidden = false;
      setTimeout(poll, ${WAKE_POLL_MS});
      return;
    }
    if (render === null) {
      location.reload();
      return;
    }
    unreachableLine.hidden = true;
    showRender(render);
    setTimeout(poll, ${WAKE_POLL_MS});
  };
  setTimeout(poll, ${WAKE_POLL_MS});
})();`;

const HOST_PAGE_CONTENT_SECURITY_POLICY = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${crypto.createHash('sha256').update(HOST_PAGE_SCRIPT).digest('base64')}'; connect-src 'self'`;

function secondsText(seconds: number): string {
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

function brandMark(): string {
  const brackets = BRAND_MARK_BRACKETS.map(({ side, d }) => `<path class="bracket" data-side="${side}" d="${d}"/>`).join('');
  return `<svg class="mark" viewBox="${BRAND_MARK_VIEWBOX}" aria-hidden="true">${brackets}<path class="light" d="${BRAND_MARK_LIGHT}"/></svg>`;
}

function hostPage({ heading, headExtra, mainAttributes, body }: { heading: string; headExtra: string; mainAttributes: string; body: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light">${headExtra}<title>${heading}</title><style>${HOST_PAGE_STYLES}</style></head><body><main${mainAttributes}>${brandMark()}<h1>${heading}</h1>${body}</main><script>${HOST_PAGE_SCRIPT}</script></body></html>`;
}

function wakeStatusText(state: WakePageState): string {
  if (state.phase === 'waking') return state.didLastWakeFail ? 'The last try got no answer. Waking the host again.' : 'Waking the host.';
  if (state.retryInMs === null) return 'This Glimmervoid cannot be woken right now. Checking again on its own.';
  return `Not waking yet. Trying again in ${secondsText(Math.max(1, Math.ceil(state.retryInMs / 1000)))}.`;
}

function wakeElapsedText(state: WakePageState): string {
  if (state.phase !== 'waking') return '';
  const elapsedSeconds = Math.floor(state.elapsedMs / 1000);
  if (elapsedSeconds > TYPICAL_WAKE_SECONDS) return `${elapsedSeconds}s, longer than the usual ${TYPICAL_WAKE_SECONDS}s`;
  return `${elapsedSeconds}s of about ${TYPICAL_WAKE_SECONDS}s`;
}

function wakeFraction(state: WakePageState): number {
  if (state.phase !== 'waking') return 0;
  return Math.min(1, Math.round(state.elapsedMs / (TYPICAL_WAKE_SECONDS * 10)) / 100);
}

function wakingPage(state: WakePageState, refreshSeconds: number): string {
  const fraction = wakeFraction(state);
  const light = state.phase === 'waking' && state.didLastWakeFail ? 'failed' : 'off';
  return hostPage({
    heading: 'Waking your Glimmervoid',
    headExtra: `<noscript><meta http-equiv="refresh" content="${refreshSeconds}"></noscript>`,
    mainAttributes: ` id="wake" data-phase="${state.phase}" data-light="${light}" data-fraction="${fraction}" style="--fraction:${fraction}"`,
    body: `<p id="wake-status" role="status" aria-live="polite">${wakeStatusText(state)}</p><div class="bar" aria-hidden="true"><div class="bar-fill"></div></div><p class="meta" id="wake-elapsed">${wakeElapsedText(state)}</p><p class="meta">It was asleep. The dashboard opens here on its own once it answers.</p><p class="meta" id="wake-unreachable" role="status" hidden>Cannot reach Glimmervoid. Checking again on its own.</p>`,
  });
}

function wakeLimitedPage(minutesUntilWake: number): string {
  return hostPage({
    heading: 'Woken too often this hour',
    headExtra: '',
    mainAttributes: '',
    body: `<p>This Glimmervoid was woken from outside too many times in the last hour, so it stays asleep for now.</p><p class="meta">It can be woken again in about ${minutesUntilWake} minute${minutesUntilWake === 1 ? '' : 's'}.</p>`,
  });
}

export { HOST_PAGE_CONTENT_SECURITY_POLICY, WAKE_POLL_HEADER, wakeLimitedPage, wakingPage };
