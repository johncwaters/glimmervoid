const element = (...args) => window.glimmervoid.element(...args);

function badge(text, tone) {
  return element('span', tone ? `badge ${tone}` : 'badge', text);
}

function myPullRequestBadges(pullRequest) {
  const badges = [element('span', 'repo', `${pullRequest.repo}#${pullRequest.number}`)];
  if (pullRequest.isDraft) badges.push(badge('draft'));
  if (pullRequest.checks.state === 'FAILURE' || pullRequest.checks.state === 'ERROR') badges.push(badge('checks failing', 'bad'));
  if (pullRequest.checks.state === 'SUCCESS') badges.push(badge('checks green', 'good'));
  if (pullRequest.reviewDecision === 'CHANGES_REQUESTED') badges.push(badge('changes requested', 'bad'));
  if (pullRequest.reviewDecision === 'APPROVED') badges.push(badge('approved', 'good'));
  if (pullRequest.unresolvedThreads > 0) badges.push(badge(`${pullRequest.unresolvedThreads} open threads`));
  return badges;
}

function teamReviewBadges(item) {
  const badges = [element('span', 'repo', `${item.review.repo}#${item.review.number} by ${item.review.author}`), badge(item.kind)];
  if (item.review.verdict) badges.push(badge(item.review.verdict.toLowerCase(), item.review.verdict.startsWith('APPROVE') ? 'good' : 'bad'));
  return badges;
}

const actionStatusByReviewKey = new Map();

async function openReviewSession(reviewKey, button) {
  button.disabled = true;
  actionStatusByReviewKey.set(reviewKey, 'Opening a session');
  render();
  const answer = await window.glimmervoid.act({ type: 'open-team-review-session', key: reviewKey });
  actionStatusByReviewKey.set(reviewKey, answer.ok ? `Opened ${answer.result.sessionName ?? 'the session'}` : answer.error);
  render();
}

function openSessionControls(reviewKey) {
  const button = element('button', 'act', 'Open session');
  button.type = 'button';
  button.disabled = actionStatusByReviewKey.get(reviewKey) === 'Opening a session';
  button.addEventListener('click', () => openReviewSession(reviewKey, button));
  const status = actionStatusByReviewKey.get(reviewKey);
  return status === undefined ? [button] : [button, element('span', 'act-status', status)];
}

function itemRow(item) {
  const row = element('li', 'pr');
  const title = item.source === 'mine' ? item.pr.title : item.review.title;
  const badges = item.source === 'mine' ? myPullRequestBadges(item.pr) : teamReviewBadges(item);
  if (item.action) badges.push(badge(item.action, 'good'));
  const controls = item.source === 'team' ? openSessionControls(item.review.key) : [];
  row.append(element('span', 'title', title || item.prKey), ...badges, ...controls);
  return row;
}

function groupSection(group) {
  const section = element('section', 'group');
  const list = element('ul', 'prs');
  list.append(...group.items.map(itemRow));
  section.append(element('h1', null, group.title), list);
  return section;
}

const FINISHED_GROUP_IDS = new Set(['done', 'parked']);
const showFinishedToggle = document.getElementById('show-finished');
let latestGroups = [];

function render() {
  const shownGroups = latestGroups.filter((group) => group.items.length > 0 && (showFinishedToggle.checked || !FINISHED_GROUP_IDS.has(group.id)));
  const turnCount = latestGroups.find((group) => group.id === 'turn')?.items.length ?? 0;
  document.getElementById('summary').textContent = `${turnCount} waiting on you`;
  document.getElementById('groups').replaceChildren(...(shownGroups.length === 0 ? [element('p', 'empty', 'Nothing in Reviews.')] : shownGroups.map(groupSection)));
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.data?.v !== 1 || event.data.kind !== 'store') return;
  showFinishedToggle.checked = event.data.data.showFinished === true;
  render();
});

showFinishedToggle.addEventListener('change', () => {
  window.parent.postMessage({ v: 1, kind: 'store-set', key: 'showFinished', value: showFinishedToggle.checked }, '*');
  render();
});

window.glimmervoid.subscribe(['reviews', 'theme'], (topic, data) => {
  if (topic === 'theme') window.glimmervoid.applyTheme(data);
  if (topic !== 'reviews') return;
  latestGroups = data.groups;
  render();
});
