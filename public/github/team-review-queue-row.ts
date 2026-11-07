import type { FindingSeverity, InFlightReview, QueuedReview, ReviewDraft } from '#shared/contracts/team-review.ts';
import { createPressable } from '../ui/pressable.ts';
import { createAuthorOrgTag, createAvatar, createReviewerStack, el, externalLink } from '../dom-helpers.ts';
import { formatAgo, formatDuration } from '../poll-ago.ts';
import { createPrStatusIcon } from './pr-status-icon.ts';
import { createSvgIcon as svgIcon, createSvgShape as svgShape } from '../svg-dom.ts';
import { githubReviewItems, githubReviewTitle, inFlightElapsedText, queueRowAgentParts, phaseLabel, pullRequestLabel, queueRowTitle, queueRowRefLabel, severityPresentation, queueRowGlyph, verdictHeading, verdictSealKind, verdictTone, viewerApprovalContext, viewerApprovalNotice } from './team-review-view-core.ts';
import type { QueueRowKind } from './team-review-view-core.ts';
import { isStreamerMode, onStreamerModeChanged } from '../streamer-mode.ts';
import { teamWaitStartMs, validTimestampMs } from './review-queue-core.ts';
import { _ageTicker, _progressTicker, _root, _view } from './team-review-panel-state.ts';

const SHARD_PATH = 'M4.5 0.5L8.5 5.5L4.5 10.5L0.5 5.5Z';

const STREAMER_GITHUB_REVIEW_TITLE = 'GitHub review';

const _queueRowTitles = new WeakMap<HTMLElement, () => string>();

function createSeverityMeter(severity: FindingSeverity): HTMLElement {
  const presentation = severityPresentation(severity);
  const meter = el('span', 'pr-severity-meter');
  meter.setAttribute('role', 'img');
  meter.setAttribute('aria-label', `${severity.toLowerCase()} severity`);
  meter.style.color = `var(${presentation.colorToken})`;
  if (severity === 'CRITICAL') {
    const halo = svgIcon(14, 17);
    halo.classList.add('pr-severity-halo');
    halo.setAttribute('viewBox', '0 0 9 11');
    halo.append(svgShape('path', { d: SHARD_PATH, fill: 'currentColor' }));
    meter.append(halo);
  }
  for (let index = 0; index < 3; index += 1) {
    const pip = svgIcon(9, 11);
    const isFilled = index < presentation.filledCount;
    pip.append(svgShape('path', { d: SHARD_PATH, fill: isFilled ? 'currentColor' : 'none', stroke: isFilled ? 'currentColor' : 'var(--border-hover)', 'stroke-width': '1' }));
    meter.append(pip);
  }
  return meter;
}

function createVerdictSeal({ verdict }: Pick<ReviewDraft, 'verdict'>): HTMLElement {
  const seal = el('span', 'pr-verdict-seal');
  seal.dataset.tone = verdictTone(verdict);
  const icon = svgIcon(20, 20);
  const kind = verdictSealKind(verdict);
  icon.append(svgShape('circle', { cx: '10', cy: '10', r: '8.5', fill: kind === 'cross' ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': '1.5' }));
  if (kind === 'check') icon.append(svgShape('path', { d: 'M6 10.5L8.7 13L14 7.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  if (kind === 'dot') icon.append(svgShape('circle', { cx: '10', cy: '10', r: '2.4', fill: 'currentColor' }));
  if (kind === 'bar') icon.append(svgShape('path', { d: 'M6 10H14', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' }));
  if (kind === 'cross') icon.append(svgShape('path', { d: 'M7 7L13 13M13 7L7 13', stroke: 'var(--bg)', 'stroke-width': '1.8', 'stroke-linecap': 'round' }));
  seal.append(icon, el('span', null, verdictHeading(verdict)));
  return seal;
}

function createQuestionGlyph(): SVGSVGElement {
  const icon = svgIcon(16, 16);
  icon.append(svgShape('rect', { x: '1', y: '1', width: '14', height: '14', rx: '2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3' }));
  icon.append(svgShape('path', { d: 'M6 6.2C6 4.9 7 4.2 8 4.2C9.1 4.2 10 5 10 6C10 7.4 8 7.4 8 9.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round' }));
  icon.append(svgShape('circle', { cx: '8', cy: '11.6', r: '0.9', fill: 'currentColor' }));
  return icon;
}

function pullRequestLink(review: Pick<ReviewDraft, 'repo' | 'number' | 'url'>): HTMLElement {
  return externalLink('pr-link', pullRequestLabel(review.repo, review.number), review.url);
}

function createAgeReadout(label: string, timestamp: number | string | null | undefined): HTMLElement | null {
  const at = validTimestampMs(timestamp);
  if (at === null) return null;
  const readout = el('span', null, `${label}${label ? ' ' : ''}${formatAgo(at)}`);
  readout.dataset.ageAt = String(at);
  readout.dataset.ageLabel = label;
  return readout;
}

function paintQueueRowTitle(row: HTMLElement): void {
  const title = _queueRowTitles.get(row);
  if (!title) return;
  row.setAttribute('aria-label', `${title()}${row.dataset.unseen ? ', new ready review' : ''}`);
}

function repaintStreamerSensitiveTitles(): void {
  _ageTicker.reset();
  trackAges(_root);
}

onStreamerModeChanged(repaintStreamerSensitiveTitles);

function trackAges(root: Element | null): void {
  if (!root) return;
  for (const row of root.querySelectorAll<HTMLElement>('.pr-queue-row')) {
    if (!_queueRowTitles.has(row)) continue;
    paintQueueRowTitle(row);
    _ageTicker.onTick(() => paintQueueRowTitle(row));
  }
  for (const notice of root.querySelectorAll<HTMLElement>('.pr-rereview-notice')) {
    const draft = _view?.drafts.find((review) => review.key === notice.dataset.reviewKey);
    const context = draft ? viewerApprovalContext(draft) : null;
    if (!context) continue;
    const paintNotice = () => { notice.textContent = viewerApprovalNotice(context, formatTimestampAge(context.submittedAt)); };
    paintNotice();
    _ageTicker.onTick(paintNotice);
  }
  for (const avatar of root.querySelectorAll<HTMLElement>('[data-review-title]')) {
    const reviewTitle = avatar.dataset.reviewTitle ?? '';
    const at = avatar.dataset.ageAt === undefined ? null : Number(avatar.dataset.ageAt);
    const paintLabel = () => {
      const age = at === null ? null : formatAgo(at);
      avatar.setAttribute('aria-label', isStreamerMode() ? githubReviewTitle(STREAMER_GITHUB_REVIEW_TITLE, age) : githubReviewTitle(reviewTitle, age));
    };
    paintLabel();
    _ageTicker.onTick(paintLabel);
  }
  for (const readout of root.querySelectorAll<HTMLElement>('[data-age-at]')) {
    if (readout.dataset.reviewTitle !== undefined) continue;
    const at = Number(readout.dataset.ageAt);
    const label = readout.dataset.ageLabel ?? '';
    const ageText = readout.dataset.ageFormat === 'duration' ? () => formatDuration(Date.now() - at) : () => formatAgo(at);
    _ageTicker.track(readout, at, () => `${label}${label ? ' ' : ''}${ageText()}`);
  }
}

function createGithubReviewSummary(draft: ReviewDraft, className: string, avatarCssPx: number, isViewerShown = true): HTMLElement | null {
  const reviews = githubReviewItems(draft, { isViewerShown });
  if (reviews.length === 0) return null;
  const summary = el('span', className);
  const items = reviews.map((review) => ({
    login: review.login, tone: review.tone,
    title: githubReviewTitle(isStreamerMode() ? STREAMER_GITHUB_REVIEW_TITLE : review.text, formatTimestampAge(review.submittedAt)),
  }));
  const stack = createReviewerStack(items, avatarCssPx);
  for (const [index, review] of reviews.entries()) {
    const avatar = stack.children[index];
    if (!(avatar instanceof HTMLElement)) continue;
    avatar.dataset.reviewTitle = review.text;
    const at = validTimestampMs(review.submittedAt);
    if (at !== null) avatar.dataset.ageAt = String(at);
  }
  summary.append(stack);
  return summary;
}

function formatTimestampAge(timestampValue: number | string | null | undefined): string | null {
  const timestamp = validTimestampMs(timestampValue);
  return timestamp === null ? null : formatAgo(timestamp);
}

function createAuthor(review: ReviewDraft | InFlightReview | QueuedReview, cssPx: number, className: string): HTMLElement {
  const author = el('span', className);
  author.append(createAvatar({ login: review.author, cssPx }), el('span', 'pr-author-login', review.author));
  const orgTag = createAuthorOrgTag(review.isAuthorOrgMember, review.repo);
  if (orgTag) author.append(orgTag);
  return author;
}

function streamerQueueRowTitle(review: ReviewDraft | InFlightReview | QueuedReview, kind: QueueRowKind): string {
  return `${pullRequestLabel(review.repo, review.number)}\n${queueRowGlyph(review, kind).meaning}`;
}

function createTeamQueueRow(review: ReviewDraft | InFlightReview | QueuedReview, kind: QueueRowKind, hasMultipleRepos: boolean): HTMLButtonElement {
  const row = createPressable('pr-queue-row pr-queue-row-quiet');
  row.dataset.reviewKey = review.key;
  const approvalContext = 'reviewedHead' in review ? viewerApprovalContext(review) : null;
  const title = () => isStreamerMode() ? streamerQueueRowTitle(review, kind) : queueRowTitle(review, kind, {
    opened: formatTimestampAge(review.prCreatedAt),
    reviewed: 'reviewedHead' in review ? formatTimestampAge(review.reviewedAt) : null,
    posted: 'reviewedHead' in review ? formatTimestampAge(review.postedAt) : null,
    viewerApproval: formatTimestampAge(approvalContext?.submittedAt),
    githubReviews: 'reviewedHead' in review ? githubReviewItems(review, { isViewerShown: kind !== 'posted' }).map((item) => formatTimestampAge(item.submittedAt)) : [],
  });
  _queueRowTitles.set(row, title);
  paintQueueRowTitle(row);
  const top = createQueueRowTop(review, hasMultipleRepos);
  if (kind === 'inReview') {
    const inFlight = review as InFlightReview;
    const elapsed = el('span', 'pr-queue-elapsed');
    _progressTicker.track(elapsed, inFlight.startedAt, () => inFlightElapsedText(inFlight, Date.now()));
    top.append(elapsed);
  }
  const waitAge = kind === 'inReview' ? null : createAgeReadout('', teamWaitStartMs(review, kind));
  if (waitAge) {
    waitAge.classList.add('pr-queue-elapsed');
    top.append(waitAge);
  }
  if (kind === 'discarded') {
    row.classList.add('pr-queue-row-compact');
    row.append(top);
    return row;
  }
  row.classList.remove('pr-queue-row-quiet');
  const rowGlyph = queueRowGlyph(review, kind);
  const glyph = el('span', 'pr-queue-glyph');
  glyph.append(createPrStatusIcon(rowGlyph.icon, rowGlyph.tone));
  const bottom = el('span', 'pr-queue-bottom');
  bottom.append(...createRowState(review, kind, rowGlyph), createAuthor(review, 16, 'pr-queue-author'));
  if (review.requestSource === 'direct') {
    const directMarker = el('span', 'pr-queue-direct', '@you');
    bottom.append(directMarker);
  }
  if (kind === 'inReview') bottom.append(el('span', 'pr-phase-label', phaseLabel((review as InFlightReview).phase)));
  row.append(glyph, top, bottom);
  const githubSummary = kind === 'inReview' || kind === 'queued' ? null : createGithubReviewSummary(review as ReviewDraft, 'pr-queue-reviewers', 16, kind !== 'posted');
  if (githubSummary) bottom.append(githubSummary);
  return row;
}

function createRowState(review: ReviewDraft | InFlightReview | QueuedReview, kind: QueueRowKind, rowGlyph: { tone: string; meaning: string }): HTMLSpanElement[] {
  if (kind !== 'ready' || !('reviewedHead' in review)) return [createRowStateWord(rowGlyph)];
  const { verdictWord, findingsSuffix } = queueRowAgentParts(review);
  return [createRowStateWord({ tone: rowGlyph.tone, meaning: verdictWord }), el('span', 'pr-queue-findings', findingsSuffix)];
}

function createRowStateWord(rowGlyph: { tone: string; meaning: string }): HTMLSpanElement {
  const stateWord = el('span', 'my-pr-stage pr-queue-state', rowGlyph.meaning);
  stateWord.dataset.tone = rowGlyph.tone;
  return stateWord;
}

function createQueueRowTop(review: ReviewDraft | InFlightReview | QueuedReview, hasMultipleRepos: boolean): HTMLSpanElement {
  const top = el('span', 'pr-queue-top');
  top.append(
    el('strong', 'pr-queue-ref', queueRowRefLabel(review.repo, review.number, hasMultipleRepos)),
    el('span', 'pr-queue-title', review.title),
  );
  return top;
}

function createCaughtUpBanner({ title, detail }: { title: string; detail: string }): HTMLElement {
  const banner = el('section', 'pr-caught-up');
  banner.setAttribute('role', 'status');
  const heading = el('strong', 'pr-caught-up-title');
  heading.append(createPrStatusIcon('ready', 'ok'), el('span', null, title));
  banner.append(heading, el('p', 'pr-caught-up-detail', detail));
  return banner;
}

export { createAgeReadout, createAuthor, createCaughtUpBanner, createGithubReviewSummary, createQuestionGlyph, createSeverityMeter, createTeamQueueRow, createVerdictSeal, formatTimestampAge, paintQueueRowTitle, pullRequestLink, trackAges };
