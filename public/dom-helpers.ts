import type { SessionState } from '#shared/states.ts';
import { BADGE_LABELS, STATE_GLYPHS, STATES } from '#shared/states.ts';
import { avatarUrlForLogin, monogramFor } from './avatar-core.ts';
import type { StateTone } from './state-tone-core.ts';

export type AdoptableElement = HTMLElement & { _adoptHome?: { parent: HTMLElement | null; next: Element | null } };

export function el<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className?: string | null,
  text?: string | null
): HTMLElementTagNameMap[Tag] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

export function elWithMarkup<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className: string, trustedMarkup: string): HTMLElementTagNameMap[Tag] {
  const element = el(tag, className);
  element.innerHTML = trustedMarkup;
  return element;
}

export function setStyleProperties(element: HTMLElement, properties: Iterable<readonly [string, string]>): void {
  for (const [propertyName, value] of properties) element.style.setProperty(propertyName, value);
}

export function createAvatar({ login, url, cssPx }: { login: string; url?: string | null; cssPx: number }): HTMLElement {
  const avatar = el('span', 'avatar');
  avatar.style.width = `${cssPx}px`;
  avatar.style.height = `${cssPx}px`;
  const monogram = () => el('span', 'avatar-monogram', monogramFor(login));
  const imageUrl = url === undefined ? avatarUrlForLogin(login, cssPx) : url;
  if (!imageUrl) {
    avatar.append(monogram());
    return avatar;
  }
  const image = el('img');
  image.src = imageUrl;
  image.width = cssPx;
  image.height = cssPx;
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.alt = '';
  image.addEventListener('error', () => image.replaceWith(monogram()), { once: true });
  avatar.append(image);
  return avatar;
}

export function createReviewerStack(reviews: readonly { login: string; tone: StateTone; title: string; url?: string | null }[], cssPx: number): HTMLElement {
  const stack = el('span', 'avatar-stack');
  for (const review of reviews) {
    const avatar = createAvatar({ login: review.login, url: review.url, cssPx });
    avatar.title = review.title;
    avatar.setAttribute('role', 'img');
    avatar.setAttribute('aria-label', review.title);
    const badge = el('span', 'avatar-badge');
    badge.dataset.tone = review.tone;
    avatar.append(badge);
    stack.append(avatar);
  }
  return stack;
}

export function queryTag<Tag extends keyof HTMLElementTagNameMap>(
  root: ParentNode,
  selector: string,
  tag: Tag
): HTMLElementTagNameMap[Tag] {
  const found = root.querySelector(selector);
  if (!found || found.tagName.toLowerCase() !== tag) throw new Error(`${selector} does not match a <${tag}>`);
  return found as HTMLElementTagNameMap[Tag];
}

export function query(root: ParentNode, selector: string): HTMLElement {
  const found = root.querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`${selector} matches no element`);
  return found;
}

export function externalLink(className: string, text: string, url: string | null | undefined, title: string = text): HTMLElement {
  if (!url) {
    const plain = el('span', className, text);
    plain.title = title;
    return plain;
  }
  const link = el('a', className, text);
  link.title = title;
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  return link;
}

export const MERGE_TAGS: Readonly<Record<string, string>> = { 'pending-review': 'REVIEW', parked: 'PARKED', merging: 'MERGING' };

export function isMonitoringState(state: string | null | undefined, awaitingBackgroundTasks: boolean | undefined): boolean {
  return state === STATES.RUNNING && awaitingBackgroundTasks === true;
}

export function stateChip(state: string, awaitingBackgroundTasks = false) {
  const knownState = state as SessionState;
  const isMonitoring = isMonitoringState(state, awaitingBackgroundTasks);
  const label = isMonitoring ? 'Monitoring' : BADGE_LABELS[knownState] || state;
  return { glyph: STATE_GLYPHS[knownState] || '', label: label.toUpperCase(), isMonitoring };
}

export function observeHeaderHeight(barEl: HTMLElement | null | undefined) {
  if (!barEl) return;
  let pendingRaf: number | null = null;
  const syncHeaderHeight = () => {
    pendingRaf = null;
    const height = barEl.offsetHeight;
    if (height > 0) document.documentElement.style.setProperty('--header-h', `${height}px`);
  };
  new ResizeObserver(() => {
    if (pendingRaf !== null) return;
    pendingRaf = requestAnimationFrame(syncHeaderHeight);
  }).observe(barEl);
}

export function buildPanelSection(prefix: string, title: string | null | undefined, hint?: string | null) {
  const section = el('section', `${prefix}-section`);
  const head = el('div', `${prefix}-section-head`);
  head.append(el('h2', `${prefix}-section-title`, title));
  if (hint) head.append(el('span', `${prefix}-section-hint`, hint));
  section.append(head);
  return section;
}

export function buildStatChip(prefix: string, label: string, value: string, tone?: string | null) {
  const wrap = el('span', `${prefix}-stat`);
  if (tone) wrap.dataset.tone = tone;
  wrap.append(el('span', `${prefix}-stat-value`, value), el('span', `${prefix}-stat-label`, label));
  return wrap;
}

export function projectsOf<Project = Record<string, unknown>>(snapshot: { projects?: unknown } | null | undefined): Project[] {
  return Array.isArray(snapshot?.projects) ? (snapshot.projects as Project[]) : [];
}

export function isPanelHidden(root: Element | null | undefined) {
  return !root || !!root.closest('[hidden]');
}

export function writeClipboardText(text: string) {
  if (!navigator.clipboard?.writeText) return null;
  return navigator.clipboard.writeText(text);
}

export function adoptElement(element: AdoptableElement | null | undefined, parentEl: HTMLElement | null | undefined) {
  if (!element || !parentEl || element.parentElement === parentEl) return;
  if (!element._adoptHome) {
    element._adoptHome = { parent: element.parentElement, next: element.nextElementSibling };
  }
  parentEl.appendChild(element);
}

export function releaseElement(element: AdoptableElement | null | undefined, fallbackParent: ParentNode | null = null) {
  const home = element?._adoptHome;
  if (!home) return;
  delete element._adoptHome;
  if (!home.parent?.isConnected) {
    if (fallbackParent) fallbackParent.appendChild(element);
    return;
  }
  if (home.next && home.next.parentElement === home.parent) {
    home.parent.insertBefore(element, home.next);
    return;
  }
  home.parent.appendChild(element);
}
