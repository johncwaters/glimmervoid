import { PACK_LOG_TEXT_MAX_CHARS } from '../../../shared/contracts/pack-bridge.ts';
import { isScriptFile, referencedPackPath, referencesIn, REMOTE_REFERENCE_PATTERN } from './pack-core.ts';

export const PACK_BRIDGE_HELPER_SOURCE = [
  '(() => {',
  '  const postLog = (level, text) => {',
  "    const isLevel = level === 'info' || level === 'warn' || level === 'error';",
  `    const line = String(text === undefined ? level : text).slice(0, ${PACK_LOG_TEXT_MAX_CHARS});`,
  "    if (line !== '') window.parent.postMessage({ v: 1, kind: 'log', level: isLevel ? level : 'info', text: line }, '*');",
  '  };',
  "  const sourceOf = (event) => (event.filename ? ' at ' + event.filename.split('/').pop() + ':' + event.lineno : '');",
  "  window.addEventListener('error', (event) => postLog('error', (event.message || 'Script error') + sourceOf(event)));",
  "  window.addEventListener('unhandledrejection', (event) => postLog('error', 'Unhandled rejection: ' + (event.reason?.stack || event.reason?.message || String(event.reason))));",
  'window.glimmervoid = {',
  '  log: postLog,',
  '  subscribe(topics, onTopic) {',
  "    window.addEventListener('message', (event) => {",
  '      if (event.source !== window.parent) return;',
  '      const message = event.data;',
  '      if (message?.v !== 1) return;',
  "      if (message.kind === 'hello') onTopic('hello', message.granted);",
  "      if (message.kind === 'topic') onTopic(message.topic, message.data);",
  '    });',
  "    window.parent.postMessage({ v: 1, kind: 'subscribe', topics }, '*');",
  '  },',
  '  act(request) {',
    "    const id = 'action-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);",
  '    return new Promise((resolve) => {',
  '      const onResult = (event) => {',
  "        if (event.source !== window.parent || event.data?.v !== 1 || event.data.kind !== 'action-result' || event.data.id !== id) return;",
  "        window.removeEventListener('message', onResult);",
  '        resolve(event.data);',
  '      };',
  "      window.addEventListener('message', onResult);",
  "      window.parent.postMessage({ v: 1, kind: 'action', id, request }, '*');",
  '    });',
  '  },',
  '  applyTheme(theme) {',
  '    for (const [property, value] of Object.entries(theme.colors)) document.documentElement.style.setProperty(property, value);',
  '  },',
  '  element(tagName, className, text) {',
  '    const element = document.createElement(tagName);',
  '    if (className) element.className = className;',
  '    if (text !== undefined) element.textContent = text;',
  '    return element;',
  '  },',
  '};',
  '})();',
].join('\n');

const HEAD_OPEN_PATTERN = /<head\b[^<>]*>/i;
const LEADING_DOCTYPE_PATTERN = /^\uFEFF?\s*<!doctype\b[^<>]{0,200}>/i;
const LINK_TAG_PATTERN = /<link\b[^<>]*>/gi;
const EMPTY_SCRIPT_TAG_PATTERN = /<script\b([^<>]*)>\s*<\/script\s*>/gi;
const AFTER_PARSE_ATTRIBUTE_PATTERN = /(?:^|\s)(?:defer|async)(?=\s|=|$)/i;
const STYLESHEET_REL_PATTERN = /\brel\s*=\s*["']?stylesheet\b/i;
const MODULE_TYPE_PATTERN = /\btype\s*=\s*["']?module\b/i;
const SCRIPT_CLOSE_PATTERN = /<\/script/gi;
const STYLE_CLOSE_PATTERN = /<\/style/gi;
const SOURCE_URL_UNSAFE_PATTERN = /[^\w./-]/g;

function attributeValue(tag: string, attributeName: string): string | null {
  const match = new RegExp(`\\b${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

function packFileText(pagePath: string, reference: string | null, filesByPath: ReadonlyMap<string, Buffer>): { filePath: string; text: string } | null {
  if (reference === null || reference === '' || reference.startsWith('/') || REMOTE_REFERENCE_PATTERN.test(reference)) return null;
  const filePath = referencedPackPath(pagePath, reference);
  const bytes = filesByPath.get(filePath);
  return bytes === undefined ? null : { filePath, text: bytes.toString('utf8') };
}

function inlinedStylesheet(pagePath: string, linkTag: string, filesByPath: ReadonlyMap<string, Buffer>): string {
  if (!STYLESHEET_REL_PATTERN.test(linkTag)) return linkTag;
  const stylesheet = packFileText(pagePath, attributeValue(linkTag, 'href'), filesByPath);
  if (stylesheet === null || referencesIn(stylesheet.filePath, stylesheet.text).length > 0) return linkTag;
  return `<style>${stylesheet.text.replace(STYLE_CLOSE_PATTERN, '<\\/style')}</style>`;
}

type InlinedScript = { tag: string; runsAfterParse: boolean };

function inlinedScript(pagePath: string, attributes: string, filesByPath: ReadonlyMap<string, Buffer>): InlinedScript | null {
  if (MODULE_TYPE_PATTERN.test(attributes)) return null;
  const script = packFileText(pagePath, attributeValue(attributes, 'src'), filesByPath);
  if (script === null || !isScriptFile(script.filePath)) return null;
  return { tag: `<script>${script.text.replace(SCRIPT_CLOSE_PATTERN, '<\\/script')}\n//# sourceURL=${script.filePath.replace(SOURCE_URL_UNSAFE_PATTERN, '_')}</script>`, runsAfterParse: AFTER_PARSE_ATTRIBUTE_PATTERN.test(attributes) };
}

function withScriptsAtBodyEnd(html: string, scriptTags: readonly string[]): string {
  if (scriptTags.length === 0) return html;
  const bodyCloseAt = html.toLowerCase().lastIndexOf('</body');
  if (bodyCloseAt === -1) return `${html}${scriptTags.join('')}`;
  return `${html.slice(0, bodyCloseAt)}${scriptTags.join('')}${html.slice(bodyCloseAt)}`;
}

function withBridgeHelper(html: string): string {
  const helperTag = `<script>${PACK_BRIDGE_HELPER_SOURCE}</script>`;
  const anchor = HEAD_OPEN_PATTERN.exec(html) ?? LEADING_DOCTYPE_PATTERN.exec(html);
  const insertAt = anchor === null ? 0 : anchor.index + anchor[0].length;
  return `${html.slice(0, insertAt)}${helperTag}${html.slice(insertAt)}`;
}

function servedPackPage(pagePath: string, html: string, filesByPath: ReadonlyMap<string, Buffer>): string {
  const withStyles = html.replace(LINK_TAG_PATTERN, (linkTag) => inlinedStylesheet(pagePath, linkTag, filesByPath));
  const scriptsRunAfterParse: string[] = [];
  const withScripts = withStyles.replace(EMPTY_SCRIPT_TAG_PATTERN, (scriptTag, attributes: string) => {
    const inlined = inlinedScript(pagePath, attributes, filesByPath);
    if (inlined === null) return scriptTag;
    if (!inlined.runsAfterParse) return inlined.tag;
    scriptsRunAfterParse.push(inlined.tag);
    return '';
  });
  return withBridgeHelper(withScriptsAtBodyEnd(withScripts, scriptsRunAfterParse));
}

export function servedPackFile(filePath: string, filesByPath: ReadonlyMap<string, Buffer>): Buffer | null {
  const bytes = filesByPath.get(filePath);
  if (bytes === undefined) return null;
  if (!filePath.endsWith('.html')) return bytes;
  return Buffer.from(servedPackPage(filePath, bytes.toString('utf8'), filesByPath), 'utf8');
}
