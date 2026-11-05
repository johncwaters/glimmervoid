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

function itemRow(item) {
  const row = element('li', 'pr');
  const title = item.source === 'mine' ? item.pr.title : item.review.title;
  const badges = item.source === 'mine' ? myPullRequestBadges(item.pr) : teamReviewBadges(item);
  if (item.action) badges.push(badge(item.action, 'good'));
  row.append(element('span', 'title', title || item.prKey), ...badges);
  return row;
}

function groupSection(group) {
  const section = element('section', 'group');
  const list = element('ul', 'prs');
  list.append(...group.items.map(itemRow));
  section.append(element('h1', null, group.title), list);
  return section;
}

window.glimmervoid.subscribe(['reviews', 'theme'], (topic, data) => {
  if (topic === 'theme') window.glimmervoid.applyTheme(data);
  if (topic !== 'reviews') return;
  const shownGroups = data.groups.filter((group) => group.items.length > 0);
  const turnCount = data.groups.find((group) => group.id === 'turn')?.items.length ?? 0;
  document.getElementById('summary').textContent = `${turnCount} waiting on you`;
  document.getElementById('groups').replaceChildren(...(shownGroups.length === 0 ? [element('p', 'empty', 'Nothing in Reviews.')] : shownGroups.map(groupSection)));
});
